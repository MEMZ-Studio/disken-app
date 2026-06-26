const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let scriptCache = {};

function decodeOutput(buf) {
  if (typeof buf === 'string') return buf;
  if (!Buffer.isBuffer(buf)) return String(buf || '');
  const str = buf.toString('utf8');
  if (str.includes('\ufffd')) {
    try { return buf.toString('gbk'); } catch(e) { return str; }
  }
  return str;
}

function safeExec(cmd, timeout) {
  try {
    const buf = execSync(cmd, { encoding: 'buffer', timeout: timeout || 15000, maxBuffer: 10 * 1024 * 1024 });
    return decodeOutput(buf);
  } catch(e) {
    return null;
  }
}

function runPsScript(scriptName, psContent, timeout) {
  try {
    const scriptPath = path.join(os.tmpdir(), `disken-${scriptName}.ps1`);
    fs.writeFileSync(scriptPath, '\uFEFF' + psContent, 'utf8');
    scriptCache[scriptName] = scriptPath;
  } catch(e) {
    return null;
  }
  const p = scriptCache[scriptName];
  const out = safeExec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${p}"`, timeout || 20000);
  if (!out) return null;
  const trimmed = out.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed;
  } catch(e) {
    return null;
  }
}

function getPhysicalDisks() {
  const ps = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Get-PhysicalDisk -ErrorAction SilentlyContinue | ForEach-Object {
  [PSCustomObject]@{
    DeviceID = [string]$_.DeviceID
    FriendlyName = $_.FriendlyName
    MediaType = $_.MediaType
    Size = [int64]$_.Size
    HealthStatus = $_.HealthStatus
    OperationalStatus = $_.OperationalStatus
    BusType = $_.BusType
  }
} | ConvertTo-Json -Compress
`;
  const r = runPsScript('physical-disks', ps, 10000);
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

function getReliabilityData() {
  const ps = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$results = @()
Get-PhysicalDisk -ErrorAction SilentlyContinue | ForEach-Object {
  $pd = $_
  $temp = $null
  $poh = $null
  $tempMax = $null
  $wear = $null
  try {
    $rc = $pd | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue
    if ($rc) {
      if ($rc.Temperature -ne $null -and [double]$rc.Temperature -gt 0 -and [double]$rc.Temperature -lt 200) {
        $temp = [int][double]$rc.Temperature
      }
      if ($rc.TemperatureMax -ne $null -and [double]$rc.TemperatureMax -gt 0 -and [double]$rc.TemperatureMax -lt 200) {
        $tempMax = [int][double]$rc.TemperatureMax
      }
      if ($rc.PowerOnHours -ne $null -and [int64]$rc.PowerOnHours -gt 0 -and [int64]$rc.PowerOnHours -lt 5000000) {
        $poh = [int64]$rc.PowerOnHours
      }
      if ($rc.Wear -ne $null -and [double]$rc.Wear -ge 0 -and [double]$rc.Wear -le 100) {
        $wear = [int][double]$rc.Wear
      }
    }
  } catch {}
  $results += [PSCustomObject]@{
    deviceId = [string]$pd.DeviceID
    temperature = $temp
    powerOnHours = $poh
    temperatureMax = $tempMax
    wear = $wear
  }
}
$results | ConvertTo-Json -Compress
`;
  const r = runPsScript('reliability', ps, 25000);
  if (!r) return {};
  const items = Array.isArray(r) ? r : [r];
  const map = {};
  for (const item of items) {
    map[String(item.deviceId)] = item;
  }
  return map;
}

function getDiskExtents() {
  const ps = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$results = @()
Get-Partition -ErrorAction SilentlyContinue | ForEach-Object {
  $p = $_
  $dl = $p | Get-Disk -ErrorAction SilentlyContinue
  if ($dl) {
    $vol = $p | Get-Volume -ErrorAction SilentlyContinue
    $results += [PSCustomObject]@{
      DiskNumber = [int]$dl.Number
      DriveLetter = if ($vol -and $vol.DriveLetter) { [string]$vol.DriveLetter } else { $null }
      Size = [int64]($p.Size)
    }
  }
}
$results | ConvertTo-Json -Compress
`;
  const r = runPsScript('extents', ps, 20000);
  const map = {};
  if (r) {
    const items = Array.isArray(r) ? r : [r];
    for (const item of items) {
      const dn = String(item.DiskNumber);
      if (item.DriveLetter) {
        if (!map[dn]) map[dn] = [];
        map[dn].push({ DriveLetter: String(item.DriveLetter), Size: Number(item.Size) || 0 });
      }
    }
    for (const k in map) {
      map[k].sort((a, b) => b.Size - a.Size);
    }
  }
  return map;
}

function getPerfCounters() {
  const ps = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Get-CimInstance Win32_PerfFormattedData_Counters_PhysicalDisk -ErrorAction SilentlyContinue | ForEach-Object {
  $n = $_.Name
  $id = $null
  if ($n -match '^PhysicalDisk (\\d+)' -or $n -match '(\\d+):') {
    $id = $matches[1]
  }
  if ($id) {
    [PSCustomObject]@{
      deviceId = $id
      readPerSec = [int64]($_.DiskReadBytesPerSecond)
      writePerSec = [int64]($_.DiskWriteBytesPerSecond)
    }
  }
} | ConvertTo-Json -Compress
`;
  const r = runPsScript('perfcounters', ps, 15000);
  const map = {};
  if (r) {
    const items = Array.isArray(r) ? r : [r];
    for (const item of items) {
      map[String(item.deviceId)] = {
        readPerSec: Number(item.readPerSec) || 0,
        writePerSec: Number(item.writePerSec) || 0
      };
    }
  }
  return map;
}

function getNvmeSmartData() {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class NvmeSmartResult {
    public bool ok;
    public int temp;
    public int percentUsed;
    public long dataUnitsRead;
    public long dataUnitsWritten;
    public long powerOnHours;
    public string reason;
    public int lastError;
}
public class NvmeSmartReader {
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern IntPtr CreateFileW(string fn, uint acc, uint share, IntPtr sa, uint cd, uint flags, IntPtr ht);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool DeviceIoControl(IntPtr h, uint code, IntPtr inBuf, uint inLen, IntPtr outBuf, uint outLen, out uint ret, IntPtr ov);

    const uint IOCTL_STORAGE_QUERY_PROPERTY = 0x002D1400;
    const uint GENERIC_READ = 0x80000000;
    const uint FILE_SHARE_READ = 0x1;
    const uint FILE_SHARE_WRITE = 0x2;
    const uint OPEN_EXISTING = 3;

    static IntPtr OpenDisk(int diskId) {
        string p = @"\\\\.\\PhysicalDrive" + diskId;
        IntPtr h = CreateFileW(p, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        if (h == (IntPtr)(-1) || h == IntPtr.Zero) {
            h = CreateFileW(p, 0, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
            if (h == (IntPtr)(-1) || h == IntPtr.Zero) return IntPtr.Zero;
        }
        return h;
    }

    public static NvmeSmartResult ReadNsid(int diskId, int nsid) {
        NvmeSmartResult result = new NvmeSmartResult();
        result.ok = false;
        result.temp = -1;
        result.reason = "";
        IntPtr h = OpenDisk(diskId);
        if (h == IntPtr.Zero) { result.reason = "cannot open"; return result; }
        try {
            int inSize = 64;
            int outSize = 4096;
            IntPtr inBuf = Marshal.AllocHGlobal(inSize);
            IntPtr outBuf = Marshal.AllocHGlobal(outSize);
            for (int i = 0; i < inSize; i++) Marshal.WriteByte(inBuf, i, 0);
            for (int i = 0; i < outSize; i++) Marshal.WriteByte(outBuf, i, 0);

            Marshal.WriteInt32(inBuf, 0, 49);
            Marshal.WriteInt32(inBuf, 4, 0);
            Marshal.WriteInt32(inBuf, 8, 3);
            Marshal.WriteInt32(inBuf, 12, 2);
            Marshal.WriteInt32(inBuf, 16, 2);
            Marshal.WriteInt32(inBuf, 20, 0);
            Marshal.WriteInt32(inBuf, 24, 40);
            Marshal.WriteInt32(inBuf, 28, 512);
            Marshal.WriteInt32(inBuf, 32, 0);
            Marshal.WriteInt32(inBuf, 36, 0);
            Marshal.WriteInt32(inBuf, 40, nsid);
            Marshal.WriteInt32(inBuf, 44, 0);

            uint ret = 0;
            bool ok = DeviceIoControl(h, IOCTL_STORAGE_QUERY_PROPERTY, inBuf, (uint)inSize, outBuf, (uint)outSize, out ret, IntPtr.Zero);
            int err = Marshal.GetLastWin32Error();
            result.lastError = err;

            if (ok && ret > 48) {
                int dataOff = 8 + 40;
                short tRaw = Marshal.ReadInt16(outBuf, dataOff + 1);
                byte pu = Marshal.ReadByte(outBuf, dataOff + 5);
                ulong dur = (ulong)Marshal.ReadInt64(outBuf, dataOff + 48);
                ulong duw = (ulong)Marshal.ReadInt64(outBuf, dataOff + 64);
                ulong poh = (ulong)Marshal.ReadInt64(outBuf, dataOff + 128);

                int tempC = -1;
                if (tRaw > 300 && tRaw < 500) {
                    tempC = tRaw - 273;
                } else if (tRaw > 0 && tRaw < 150) {
                    tempC = tRaw;
                }

                bool hasTemp = tempC > 0 && tempC < 150;
                bool hasPoh = poh > 0 && poh < 5000000;
                bool hasData = (dur > 0 || duw > 0);

                if (hasTemp || hasPoh || hasData) {
                    result.ok = true;
                    result.temp = tempC;
                    result.percentUsed = (int)pu;
                    result.dataUnitsRead = (long)dur;
                    result.dataUnitsWritten = (long)duw;
                    result.powerOnHours = (long)poh;
                } else {
                    result.reason = "invalid data";
                }
            } else {
                result.reason = "ioctl failed";
            }
            Marshal.FreeHGlobal(inBuf);
            Marshal.FreeHGlobal(outBuf);
            return result;
        } catch (Exception ex) { result.reason = ex.Message; return result; } finally { CloseHandle(h); }
    }

    public static NvmeSmartResult Read(int diskId) {
        // 优先尝试NSID=0（兼容性最好），然后NSID=1，最后广播
        int[] nsids = { 0, 1, unchecked((int)0xFFFFFFFF) };
        foreach (int nsid in nsids) {
            NvmeSmartResult r = ReadNsid(diskId, nsid);
            if (r.ok) return r;
        }
        return ReadNsid(diskId, 0);
    }
}
'@
$results = @()
Get-PhysicalDisk -ErrorAction SilentlyContinue | Where-Object { $_.BusType -eq 'NVMe' } | ForEach-Object {
    $devId = [int]$_.DeviceID
    $nv = [NvmeSmartReader]::Read($devId)
    $results += [PSCustomObject]@{
        deviceId = [string]$devId
        nvmeResult = $nv
    }
}
$results | ConvertTo-Json -Compress -Depth 3
`;
  const r = runPsScript('nvme-smart', ps, 30000);
  const map = {};
  if (r) {
    const items = Array.isArray(r) ? r : [r];
    for (const item of items) {
      const nv = item.nvmeResult;
      if (nv && nv.ok) {
        const dur = Number(nv.dataUnitsRead) || 0;
        const duw = Number(nv.dataUnitsWritten) || 0;
        const temp = Number(nv.temp) || -1;
        const poh = Number(nv.powerOnHours) || 0;
        map[String(item.deviceId)] = {
          temperature: temp > 0 && temp < 150 ? temp : null,
          powerOnHours: poh > 0 && poh < 20000000 ? poh : null,
          percentUsed: nv.percentUsed >= 0 && nv.percentUsed <= 100 ? Number(nv.percentUsed) : null,
          totalBytesRead: dur > 0 ? dur * 512000 : null,
          totalBytesWritten: duw > 0 ? duw * 512000 : null
        };
      }
    }
  }
  return map;
}

function getAllDiskSmart() {
  const disks = getPhysicalDisks();
  const extents = getDiskExtents();
  const relData = getReliabilityData();
  const nvmeData = getNvmeSmartData();
  const perfData = getPerfCounters();

  const driveLetterMap = {};
  for (const dk of Object.keys(extents)) {
    if (extents[dk] && extents[dk].length > 0) {
      driveLetterMap[dk] = extents[dk][0].DriveLetter;
    }
  }

  return disks.map(d => {
    const devId = String(d.DeviceID);
    const rel = relData[devId] || {};
    const nv = nvmeData[devId] || {};
    const pf = perfData[devId] || {};
    const driveLetter = driveLetterMap[devId] || null;
    const busType = d.BusType || 'Unknown';

    let temperature = null;
    let powerOnHours = null;
    let totalBytesRead = null;
    let totalBytesWritten = null;
    let healthPercent = null;
    let dataSource = 'none';
    let smartUnavailable = false;

    const isUsb = busType === 'USB';

    if (nv.temperature != null) {
      temperature = nv.temperature;
      dataSource = 'nvme_smart';
    } else if (rel.temperature != null) {
      temperature = rel.temperature;
      dataSource = 'reliability_counter';
    }

    if (nv.powerOnHours != null) {
      powerOnHours = nv.powerOnHours;
      dataSource = 'nvme_smart';
    } else if (rel.powerOnHours != null) {
      powerOnHours = rel.powerOnHours;
      if (dataSource === 'none') dataSource = 'reliability_counter';
    }

    if (nv.totalBytesRead != null) totalBytesRead = nv.totalBytesRead;
    if (nv.totalBytesWritten != null) totalBytesWritten = nv.totalBytesWritten;
    if (nv.percentUsed != null) {
      healthPercent = Math.max(0, Math.min(100, 100 - nv.percentUsed));
    } else if (rel.wear != null) {
      healthPercent = Math.max(0, Math.min(100, 100 - rel.wear));
    }

    if (isUsb) {
      smartUnavailable = true;
      dataSource = 'usb_unavailable';
    } else if (temperature == null && powerOnHours == null && totalBytesRead == null && totalBytesWritten == null) {
      smartUnavailable = true;
    }

    return {
      deviceId: d.DeviceID,
      model: d.FriendlyName || 'Unknown Disk',
      interfaceType: busType,
      mediaType: d.MediaType || 'Unspecified',
      capacity: d.Size || 0,
      health: d.HealthStatus || 'Unknown',
      healthPercent: healthPercent,
      temperature: temperature,
      powerOnHours: powerOnHours,
      totalBytesRead: totalBytesRead,
      totalBytesWritten: totalBytesWritten,
      totalReads: null,
      totalWrites: null,
      driveLetter: driveLetter,
      readPerSec: pf.readPerSec || 0,
      writePerSec: pf.writePerSec || 0,
      dataSource: dataSource,
      smartUnavailable: smartUnavailable,
      isUsb: isUsb
    };
  });
}

module.exports = { getAllDiskSmart };
