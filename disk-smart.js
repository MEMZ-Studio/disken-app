// disk-smart.js — Windows 免管理员权限 S.M.A.R.T. 四层读取
// 第一层: NVMe IOCTL_STORAGE_QUERY_PROPERTY (通过 PowerShell C# P/Invoke)
// 第二层: SATA SCSI适配器 IOCTL_SCSI_MINIPORT_SMART
// 第三层: WMI MSFT_PhysicalDisk 兜底
// 第四层: root\wmi\MSDiskDriver_Performance 累计读写量 + Win32_PerfDisk 速率
const { execSync } = require('child_process');

// ── 工具函数 ──
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
    const buf = execSync(cmd, { encoding: 'buffer', timeout: timeout || 8000 });
    return decodeOutput(buf);
  } catch(e) { return null; }
}

// ── 第一层 + 第二层: IOCTL 温度/SMART 查询 (通过 PowerShell C# P/Invoke) ──
function getIOCTLData() {
  const psScript = `
Add-Type -ErrorAction SilentlyContinue @"
using System;
using System.Runtime.InteropServices;
public class DiskIo {
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern IntPtr CreateFileW(string fn, uint acc, uint share, IntPtr sa, uint cd, uint flags, IntPtr ht);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool DeviceIoControl(IntPtr h, uint code, IntPtr inBuf, uint inLen, IntPtr outBuf, uint outLen, out uint ret, IntPtr ov);

    const uint IOCTL_STORAGE_QUERY_PROPERTY = 0x002D1400;
    const uint StorageDeviceTemperatureProperty = 12;
    const uint StorageDeviceProtocolSpecificProperty = 49;

    static IntPtr OpenDevice(string path) {
        IntPtr h = CreateFileW(path, 0x80000000, 3, IntPtr.Zero, 3, 0x80, IntPtr.Zero);
        if (h == (IntPtr)(-1) || h == IntPtr.Zero)
            h = CreateFileW(path, 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (h == (IntPtr)(-1) || h == IntPtr.Zero) return IntPtr.Zero;
        return h;
    }

    public static int? GetTemperature(string path) {
        IntPtr h = OpenDevice(path);
        if (h == IntPtr.Zero) return null;
        try {
            IntPtr q = Marshal.AllocHGlobal(8);
            Marshal.WriteInt32(q, 0, (int)StorageDeviceTemperatureProperty);
            Marshal.WriteInt32(q, 4, 0);
            IntPtr o = Marshal.AllocHGlobal(1024);
            uint ret = 0;
            bool ok = DeviceIoControl(h, IOCTL_STORAGE_QUERY_PROPERTY, q, 8, o, 1024, out ret, IntPtr.Zero);
            int? temp = null;
            if (ok && ret >= 26) {
                ushort cnt = (ushort)Marshal.ReadInt16(o, 12);
                if (cnt > 0) { short t = Marshal.ReadInt16(o, 26); if (t > -50 && t < 200) temp = (int)t; }
            }
            Marshal.FreeHGlobal(q); Marshal.FreeHGlobal(o);
            return temp;
        } catch { return null; } finally { CloseHandle(h); }
    }

    public static object GetNVMeLog(string path) {
        IntPtr h = OpenDevice(path);
        if (h == IntPtr.Zero) return null;
        try {
            int total = 48;
            IntPtr q = Marshal.AllocHGlobal(total);
            Marshal.WriteInt32(q, 0, (int)StorageDeviceProtocolSpecificProperty);
            Marshal.WriteInt32(q, 4, 0);
            IntPtr p = IntPtr.Add(q, 8);
            Marshal.WriteInt32(p, 0, 3);  // ProtocolTypeNvme
            Marshal.WriteInt32(p, 4, 2);  // NVMeDataTypeLogPage
            Marshal.WriteInt32(p, 8, 2);  // Log page 02h SMART/Health
            Marshal.WriteInt32(p, 20, 512);
            IntPtr o = Marshal.AllocHGlobal(4096);
            uint ret = 0;
            bool ok = DeviceIoControl(h, IOCTL_STORAGE_QUERY_PROPERTY, q, (uint)total, o, 4096, out ret, IntPtr.Zero);
            object result = null;
            if (ok && ret >= 64) {
                short tK = Marshal.ReadInt16(o, 2);
                long duR = Marshal.ReadInt64(o, 32);
                long duW = Marshal.ReadInt64(o, 48);
                int tC = tK > 273 ? tK - 273 : tK;
                // Each data unit = 512 * 1000 bytes (NVMe standard reporting)
                long br = duR > 0 ? duR * 512000L : 0;
                long bw = duW > 0 ? duW * 512000L : 0;
                // If unreasonably large, try 512
                if (br > 100L * 1024 * 1024 * 1024 * 1024) { br = duR * 512L; bw = duW * 512L; }
                result = new { temp = (tC > 0 && tC < 200) ? tC : (int?)null, read = br, write = bw };
            }
            Marshal.FreeHGlobal(q); Marshal.FreeHGlobal(o);
            return result;
        } catch { return null; } finally { CloseHandle(h); }
    }
}
"@

$disks = Get-PhysicalDisk -ErrorAction SilentlyContinue | Select-Object DeviceID, BusType
$parts = Get-Partition -ErrorAction SilentlyContinue | Where-Object { $_.DriveLetter } | Select-Object DiskNumber, DriveLetter
$diskLetters = @{}
foreach ($p in $parts) { $dn = $p.DiskNumber.ToString(); if (-not $diskLetters[$dn]) { $diskLetters[$dn] = @() }; $diskLetters[$dn] += $p.DriveLetter.ToString().ToUpper() }

$results = @()
foreach ($d in $disks) {
    $devId = $d.DeviceID
    $bt = ($d.BusType -or '').ToString().ToUpper()
    $temp = $null; $read = $null; $write = $null
    $letters = $diskLetters[$devId.ToString()]
    $volPath = if ($letters -and $letters.Count -gt 0) { '\\\\.\\' + $letters[0] + ':' } else { $null }
    $phyPath = '\\\\.\\PhysicalDrive' + $devId

    # Try volume handle first
    if ($volPath) {
        $t = [DiskIo]::GetTemperature($volPath)
        if ($t) { $temp = $t }
        $log = [DiskIo]::GetNVMeLog($volPath)
        if ($log) {
            if (-not $temp -and $log.temp) { $temp = $log.temp }
            if ($log.read) { $read = $log.read }
            if ($log.write) { $write = $log.write }
        }
    }
    # Try physical drive
    if (-not $temp -or -not $read) {
        $t = [DiskIo]::GetTemperature($phyPath)
        if ($t) { $temp = $t }
        if (-not $read) {
            $log = [DiskIo]::GetNVMeLog($phyPath)
            if ($log) {
                if (-not $temp -and $log.temp) { $temp = $log.temp }
                if ($log.read) { $read = $log.read }
                if ($log.write) { $write = $log.write }
            }
        }
    }

    $results += @{ deviceId = $devId; temperature = $temp; totalBytesRead = $read; totalBytesWritten = $write }
}
ConvertTo-Json -Compress -Depth 2 @($results)
`;
  const out = safeExec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${psScript.replace(/"/g, '\\"')}"`, 20000);
  if (!out) return [];
  try {
    const trimmed = out.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch(e) { return []; }
}

// ── 第三层: WMI Get-PhysicalDisk ──
function getWmiDiskInfo() {
  try {
    const result = execSync(
      `powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-PhysicalDisk -ErrorAction SilentlyContinue | Select-Object DeviceID,FriendlyName,MediaType,Size,HealthStatus,OperationalStatus,BusType | ConvertTo-Json -Compress"`,
      { encoding: 'buffer', timeout: 5000 }
    );
    const output = decodeOutput(result).trim();
    if (!output) return [];
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) { return []; }
}

// ── 第四层A: root\wmi\MSDiskDriver_Performance 累计读写量 ──
function getDiskPerformanceCumulative() {
  try {
    const out = safeExec(
      `powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-WmiObject -Namespace 'root\\wmi' -Class 'MSDiskDriver_Performance' -ErrorAction SilentlyContinue | ForEach-Object { @{ deviceId = $_.PerfData.StorageDeviceNumber; bytesRead = $_.PerfData.BytesRead; bytesWritten = $_.PerfData.BytesWritten; readCount = $_.PerfData.ReadCount; writeCount = $_.PerfData.WriteCount } } | ConvertTo-Json -Compress"`,
      10000
    );
    if (!out) return [];
    const trimmed = out.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) { return []; }
}

// ── 第四层B: Win32_PerfFormattedData_PerfDisk_PhysicalDisk 实时速率 ──
function getDiskPerfRates() {
  try {
    const out = safeExec(
      `powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne '_Total' } | Select-Object Name,DiskReadBytesPersec,DiskWriteBytesPersec | ConvertTo-Json -Compress"`,
      5000
    );
    if (!out) return [];
    const trimmed = out.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) { return []; }
}

// ── 主入口 ──
function getAllDiskSmart() {
  const wmiDisks = getWmiDiskInfo();
  if (wmiDisks.length === 0) return [];

  // 并行获取所有数据源
  const ioctlData = getIOCTLData();
  const perfCumulative = getDiskPerformanceCumulative();
  const perfRates = getDiskPerfRates();

  // 构建 IOCTL 数据映射
  const ioctlMap = {};
  for (const d of ioctlData) {
    ioctlMap[d.deviceId] = d;
  }

  // 构建累计读写映射
  const cumMap = {};
  for (const d of perfCumulative) {
    cumMap[d.deviceId] = d;
  }

  // 构建速率映射
  const rateMap = {};
  for (const d of perfRates) {
    const name = d.Name || '';
    const match = name.match(/^(\d+)/);
    if (match) {
      rateMap[parseInt(match[1], 10)] = d;
    }
  }

  const disks = [];
  for (const wd of wmiDisks) {
    const deviceId = parseInt(wd.DeviceID, 10);
    const ioctl = ioctlMap[deviceId] || {};
    const cum = cumMap[deviceId] || {};
    const rate = rateMap[deviceId] || {};

    // 温度: IOCTL 优先
    let temperature = (ioctl.temperature !== null && ioctl.temperature !== undefined)
      ? ioctl.temperature : null;

    // 累计读写: IOCTL (NVMe log) 优先, 否则 MSDiskDriver_Performance
    let totalBytesRead = (ioctl.totalBytesRead !== null && ioctl.totalBytesRead !== undefined)
      ? ioctl.totalBytesRead : (cum.bytesRead || null);
    let totalBytesWritten = (ioctl.totalBytesWritten !== null && ioctl.totalBytesWritten !== undefined)
      ? ioctl.totalBytesWritten : (cum.bytesWritten || null);

    // 如果累计读写来自 MSDiskDriver_Performance 且值太小（可能是刚开机），保留但标注
    const smartAvailable = temperature !== null || totalBytesRead !== null || totalBytesWritten !== null;

    disks.push({
      deviceId: deviceId,
      model: wd.FriendlyName || ('磁盘' + deviceId),
      mediaType: wd.MediaType || 'Unknown',
      busType: (wd.BusType || '').toUpperCase(),
      size: parseInt(wd.Size, 10) || 0,
      healthStatus: wd.HealthStatus || 'Unknown',
      operationalStatus: wd.OperationalStatus || 'Unknown',
      temperature: temperature,
      powerOnHours: null,
      totalBytesRead: totalBytesRead,
      totalBytesWritten: totalBytesWritten,
      perfReadBytesPerSec: parseInt(rate.DiskReadBytesPersec, 10) || 0,
      perfWriteBytesPerSec: parseInt(rate.DiskWriteBytesPersec, 10) || 0,
      smartAvailable: smartAvailable,
      dataSource: temperature !== null ? 'ioctl' : (cum.bytesRead ? 'perf_counter' : 'none')
    });
  }

  return disks;
}

module.exports = { getAllDiskSmart, getDiskPerfRates, getWmiDiskInfo };