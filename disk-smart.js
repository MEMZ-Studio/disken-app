const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let combinedScriptPath = null;

function decodeOutput(buf) {
  if (typeof buf === 'string') return buf;
  if (!Buffer.isBuffer(buf)) return String(buf || '');
  const str = buf.toString('utf8');
  if (str.includes('\ufffd')) {
    try { return buf.toString('gbk'); } catch(e) { return str; }
  }
  return str;
}

function buildCombinedScript() {
  return `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

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
        IntPtr h = OpenDisk(diskId);
        if (h == IntPtr.Zero) return result;
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
                }
            }
            Marshal.FreeHGlobal(inBuf);
            Marshal.FreeHGlobal(outBuf);
            return result;
        } catch (Exception) { return result; } finally { CloseHandle(h); }
    }

    public static NvmeSmartResult Read(int diskId) {
        int[] nsids = { 0, 1, unchecked((int)0xFFFFFFFF) };
        foreach (int nsid in nsids) {
            NvmeSmartResult r = ReadNsid(diskId, nsid);
            if (r.ok) return r;
        }
        return ReadNsid(diskId, 0);
    }
}
'@

$disks = @(Get-PhysicalDisk -ErrorAction SilentlyContinue | ForEach-Object {
  [PSCustomObject]@{
    DeviceID = [string]$_.DeviceID
    FriendlyName = $_.FriendlyName
    MediaType = $_.MediaType
    Size = [int64]$_.Size
    HealthStatus = $_.HealthStatus
    OperationalStatus = $_.OperationalStatus
    BusType = $_.BusType
  }
})

$extents = @(Get-Partition -ErrorAction SilentlyContinue | ForEach-Object {
  $p = $_
  $dl = $p | Get-Disk -ErrorAction SilentlyContinue
  if ($dl) {
    $vol = $p | Get-Volume -ErrorAction SilentlyContinue
    [PSCustomObject]@{
      DiskNumber = [int]$dl.Number
      DriveLetter = if ($vol -and $vol.DriveLetter) { [string]$vol.DriveLetter } else { $null }
      Size = [int64]($p.Size)
      VolumeSize = if ($vol) { [int64]($vol.Size) } else { 0 }
      VolumeFree = if ($vol) { [int64]($vol.SizeRemaining) } else { 0 }
      VolumeLabel = if ($vol) { $vol.FileSystemLabel } else { $null }
    }
  }
})

$reliability = @()
foreach ($pd in (Get-PhysicalDisk -ErrorAction SilentlyContinue)) {
  $temp = $null; $poh = $null; $wear = $null
  try {
    $rc = $pd | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue
    if ($rc) {
      if ($rc.Temperature -ne $null -and [double]$rc.Temperature -gt 0 -and [double]$rc.Temperature -lt 200) {
        $temp = [int][double]$rc.Temperature
      }
      if ($rc.PowerOnHours -ne $null -and [int64]$rc.PowerOnHours -gt 0 -and [int64]$rc.PowerOnHours -lt 5000000) {
        $poh = [int64]$rc.PowerOnHours
      }
      if ($rc.Wear -ne $null -and [double]$rc.Wear -ge 0 -and [double]$rc.Wear -le 100) {
        $wear = [int][double]$rc.Wear
      }
    }
  } catch {}
  $reliability += [PSCustomObject]@{
    deviceId = [string]$pd.DeviceID
    temperature = $temp
    powerOnHours = $poh
    wear = $wear
  }
}

$nvmeSmart = @()
foreach ($pd in (Get-PhysicalDisk -ErrorAction SilentlyContinue | Where-Object { $_.BusType -eq 'NVMe' })) {
  $devId = [int]$pd.DeviceID
  $nv = [NvmeSmartReader]::Read($devId)
  $nvmeSmart += [PSCustomObject]@{
    deviceId = [string]$devId
    nvOk = $nv.ok
    nvTemp = $nv.temp
    nvPercentUsed = $nv.percentUsed
    nvDur = $nv.dataUnitsRead
    nvDuw = $nv.dataUnitsWritten
    nvPoh = $nv.powerOnHours
  }
}

$perfcounters = @()
Get-CimInstance Win32_PerfFormattedData_Counters_PhysicalDisk -ErrorAction SilentlyContinue | ForEach-Object {
  $n = $_.Name
  $id = $null
  if ($n -match '^PhysicalDisk (\\d+)' -or $n -match '(\\d+):') {
    $id = $matches[1]
  }
  if ($id) {
    $perfcounters += [PSCustomObject]@{
      deviceId = $id
      readPerSec = [int64]($_.DiskReadBytesPerSecond)
      writePerSec = [int64]($_.DiskWriteBytesPerSecond)
    }
  }
}

$result = [PSCustomObject]@{
  disks = $disks
  extents = $extents
  reliability = $reliability
  nvmeSmart = $nvmeSmart
  perfcounters = $perfcounters
}
$result | ConvertTo-Json -Compress -Depth 4
`;
}

function ensureScript() {
  if (combinedScriptPath) return;
  try {
    combinedScriptPath = path.join(os.tmpdir(), 'disken-all-smart-v2.ps1');
    fs.writeFileSync(combinedScriptPath, '\uFEFF' + buildCombinedScript(), 'utf8');
  } catch(e) {
    combinedScriptPath = null;
  }
}

function runCombinedQuery(timeout) {
  ensureScript();
  if (!combinedScriptPath) return null;
  try {
    const buf = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${combinedScriptPath}"`,
      { encoding: 'buffer', timeout: timeout || 12000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }
    );
    const out = decodeOutput(buf).trim();
    if (!out) return null;
    return JSON.parse(out);
  } catch(e) {
    return null;
  }
}

function getAllDiskSmart() {
  const data = runCombinedQuery(12000);
  if (!data || !data.disks) return [];

  const diskList = Array.isArray(data.disks) ? data.disks : [data.disks];
  
  // 构建磁盘到分区/卷的映射
  const extentMap = {};
  const volMap = {}; // driveLetter -> {size, free, label}
  const extents = Array.isArray(data.extents) ? data.extents : (data.extents ? [data.extents] : []);
  for (const item of extents) {
    const dn = String(item.DiskNumber);
    const dl = item.DriveLetter ? String(item.DriveLetter).toUpperCase() : null;
    if (dl) {
      if (!extentMap[dn]) extentMap[dn] = [];
      const volSize = Number(item.VolumeSize) || 0;
      const volFree = Number(item.VolumeFree) || 0;
      const volLabel = item.VolumeLabel || null;
      extentMap[dn].push({ DriveLetter: dl, Size: Number(item.Size) || 0, VolumeSize: volSize, VolumeFree: volFree, VolumeLabel: volLabel });
      if (!volMap[dl]) {
        volMap[dl] = { size: volSize, free: volFree, label: volLabel };
      } else {
        // 同一盘符可能有多个分区，累加大小
        volMap[dl].size += volSize;
        volMap[dl].free += volFree;
      }
    }
  }
  for (const k in extentMap) {
    extentMap[k].sort((a, b) => b.Size - a.Size);
  }

  const relMap = {};
  const relItems = Array.isArray(data.reliability) ? data.reliability : (data.reliability ? [data.reliability] : []);
  for (const item of relItems) {
    relMap[String(item.deviceId)] = item;
  }

  const nvmeMap = {};
  const nvItems = Array.isArray(data.nvmeSmart) ? data.nvmeSmart : (data.nvmeSmart ? [data.nvmeSmart] : []);
  for (const item of nvItems) {
    if (item.nvOk) {
      const dur = Number(item.nvDur) || 0;
      const duw = Number(item.nvDuw) || 0;
      const temp = Number(item.nvTemp) || -1;
      const poh = Number(item.nvPoh) || 0;
      nvmeMap[String(item.deviceId)] = {
        temperature: temp > 0 && temp < 150 ? temp : null,
        powerOnHours: poh > 0 && poh < 20000000 ? poh : null,
        percentUsed: item.nvPercentUsed >= 0 && item.nvPercentUsed <= 100 ? Number(item.nvPercentUsed) : null,
        totalBytesRead: dur > 0 ? dur * 512000 : null,
        totalBytesWritten: duw > 0 ? duw * 512000 : null
      };
    }
  }

  const perfMap = {};
  const perfItems = Array.isArray(data.perfcounters) ? data.perfcounters : (data.perfcounters ? [data.perfcounters] : []);
  for (const item of perfItems) {
    perfMap[String(item.deviceId)] = {
      readPerSec: Number(item.readPerSec) || 0,
      writePerSec: Number(item.writePerSec) || 0
    };
  }

  const driveLetterMap = {};
  const lettersList = {}; // deviceId -> [driveLetters]
  const diskVolumes = {}; // deviceId -> {total, free}
  for (const dk of Object.keys(extentMap)) {
    if (extentMap[dk] && extentMap[dk].length > 0) {
      const letters = extentMap[dk].map(e => e.DriveLetter);
      driveLetterMap[dk] = letters[0];
      lettersList[dk] = letters;
      let totalV = 0, freeV = 0;
      for (const e of extentMap[dk]) {
        totalV += e.VolumeSize || 0;
        freeV += e.VolumeFree || 0;
      }
      diskVolumes[dk] = { total: totalV, free: freeV };
    }
  }

  return diskList.map(d => {
    const devId = String(d.DeviceID);
    const rel = relMap[devId] || {};
    const nv = nvmeMap[devId] || {};
    const pf = perfMap[devId] || {};
    const driveLetter = driveLetterMap[devId] || null;
    const allLetters = lettersList[devId] || [];
    const vols = diskVolumes[devId] || { total: 0, free: 0 };
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
      healthStatus: d.HealthStatus || 'Unknown',
      opStatus: d.OperationalStatus || 'OK',
      healthPercent: healthPercent,
      temperature: temperature,
      powerOnHours: powerOnHours,
      totalBytesRead: totalBytesRead,
      totalBytesWritten: totalBytesWritten,
      totalReads: null,
      totalWrites: null,
      driveLetter: driveLetter,
      driveLetters: allLetters,
      volTotal: vols.total,
      volFree: vols.free,
      readPerSec: pf.readPerSec || 0,
      writePerSec: pf.writePerSec || 0,
      dataSource: dataSource,
      smartUnavailable: smartUnavailable,
      isUsb: isUsb
    };
  });
}

// 预生成脚本
ensureScript();

module.exports = { getAllDiskSmart };
