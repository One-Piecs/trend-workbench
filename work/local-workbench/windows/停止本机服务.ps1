param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
$appDirectory = [IO.Path]::GetFullPath($PSScriptRoot)
$nodePath = Join-Path $appDirectory 'runtime\node.exe'
$serverPath = Join-Path $appDirectory 'server.mjs'
$response = $null
$reader = $null
try {
    $request = [Net.HttpWebRequest]::Create('http://127.0.0.1:43127/health')
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = 2000
    $request.ReadWriteTimeout = 2000
    $response = $request.GetResponse()
    $reader = New-Object IO.StreamReader($response.GetResponseStream())
    $buffer = New-Object char[] 4096
    $length = $reader.ReadBlock($buffer, 0, $buffer.Length)
    if ($length -eq $buffer.Length) { throw '服务身份响应异常，未停止任何进程。' }
    $body = New-Object string($buffer, 0, $length)
    $health = $body | ConvertFrom-Json
    if ($health.app -ne 'trend-workbench' -or [string]::IsNullOrWhiteSpace($health.version)) { throw '端口由其他服务使用，未停止任何进程。' }
    $serverPid = 0
    if (![int]::TryParse([string]$health.pid, [ref]$serverPid) -or $serverPid -le 0) { throw '服务进程信息无效。' }
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $serverPid)
    if ($null -eq $process -or [string]::IsNullOrWhiteSpace($process.ExecutablePath) -or [string]::IsNullOrWhiteSpace($process.CommandLine)) { throw '无法核实服务进程，未停止任何进程。' }
    if (![string]::Equals([IO.Path]::GetFullPath($process.ExecutablePath), $nodePath, [StringComparison]::OrdinalIgnoreCase)) { throw '进程不属于此工作台，未停止任何进程。' }
    if (!('TrendWorkbenchStopArgs' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TrendWorkbenchStopArgs {
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr CommandLineToArgvW(string text, out int count);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr value);
    public static string[] Split(string text) {
        int count; IntPtr values=CommandLineToArgvW(text,out count);
        if(values==IntPtr.Zero) throw new InvalidOperationException("Cannot parse process arguments.");
        try { string[] args=new string[count]; for(int i=0;i<count;i++) args[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(values,i*IntPtr.Size)); return args; }
        finally { LocalFree(values); }
    }
}
'@
    }
    $arguments = [TrendWorkbenchStopArgs]::Split($process.CommandLine)
    if ($arguments.Length -ne 4 -or $arguments[2] -ne '--port' -or $arguments[3] -ne '43127' -or ![IO.Path]::IsPathRooted($arguments[1])) { throw '进程启动参数不匹配，未停止任何进程。' }
    if (![string]::Equals([IO.Path]::GetFullPath($arguments[1]), $serverPath, [StringComparison]::OrdinalIgnoreCase)) { throw '进程运行的不是此工作台服务，未停止任何进程。' }
    Stop-Process -Id $serverPid -ErrorAction Stop
    Write-Output '趋势判断工作台的本机服务已停止。下次双击桌面图标会自动启动。'
    if (!$Quiet) { Read-Host '按回车关闭' | Out-Null }
}
catch [Net.WebException] {
    Write-Output '本机服务未运行或暂时无法连接，没有停止任何进程。'
    if (!$Quiet) { Read-Host '按回车关闭' | Out-Null }
}
catch {
    Write-Error $_.Exception.Message -ErrorAction Continue
    if (!$Quiet) { Read-Host '按回车关闭' | Out-Null }
    exit 1
}
finally {
    if ($null -ne $reader) { $reader.Dispose() }
    if ($null -ne $response) { $response.Dispose() }
}
