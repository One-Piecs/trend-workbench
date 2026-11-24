param(
    [switch]$NoWindow,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$appDirectory = [IO.Path]::GetFullPath($PSScriptRoot)
$nodePath = Join-Path $appDirectory 'runtime\node.exe'
$serverPath = Join-Path $appDirectory 'server.mjs'
$entryPath = Join-Path $appDirectory 'public\index.html'
$manifestPath = Join-Path $appDirectory 'build-info.json'
$logDirectory = Join-Path $appDirectory 'logs'
$launchMutex = $null
$ownsMutex = $false
$startedProcess = $null

function Get-LocalHealth {
    $response = $null
    $reader = $null
    try {
        $request = [Net.HttpWebRequest]::Create($appUrl + 'health')
        $request.Proxy = $null
        $request.AllowAutoRedirect = $false
        $request.Timeout = 1500
        $request.ReadWriteTimeout = 1500
        $response = $request.GetResponse()
        if ([int]$response.StatusCode -ne 200) { return $null }
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        $buffer = New-Object char[] 4096
        $length = $reader.ReadBlock($buffer, 0, $buffer.Length)
        if ($length -eq $buffer.Length) { return $null }
        $body = New-Object string($buffer, 0, $length)
        return ($body | ConvertFrom-Json)
    }
    catch { return $null }
    finally {
        if ($null -ne $reader) { $reader.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
    }
}

function Test-LocalPortInUse {
    return @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq $serverPort }).Count -gt 0
}

function Initialize-ArgumentParser {
    if ('TrendWorkbenchNativeArgs' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TrendWorkbenchNativeArgs {
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr pointer);
    public static string[] Split(string commandLine) {
        int count;
        IntPtr result = CommandLineToArgvW(commandLine, out count);
        if (result == IntPtr.Zero) throw new InvalidOperationException("Cannot parse process command line.");
        try {
            string[] args = new string[count];
            for (int i=0; i<count; i++) args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(result, i*IntPtr.Size));
            return args;
        } finally { LocalFree(result); }
    }
}
'@
}

function Get-VerifiedServerProcess([int]$serverPid) {
    if ($serverPid -le 0) { return $null }
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $serverPid) -ErrorAction SilentlyContinue
    if ($null -eq $process -or [string]::IsNullOrWhiteSpace($process.ExecutablePath) -or [string]::IsNullOrWhiteSpace($process.CommandLine)) { return $null }
    if (![string]::Equals([IO.Path]::GetFullPath($process.ExecutablePath), $nodePath, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    $arguments = [TrendWorkbenchNativeArgs]::Split($process.CommandLine)
    if ($arguments.Length -ne 4 -or $arguments[2] -ne '--port' -or $arguments[3] -ne [string]$serverPort) { return $null }
    if (![IO.Path]::IsPathRooted($arguments[1])) { return $null }
    if (![string]::Equals([IO.Path]::GetFullPath($arguments[1]), $serverPath, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    return $process
}

function Test-WorkbenchIdentity($health) {
    if ($null -eq $health -or $health.app -ne 'trend-workbench' -or [string]::IsNullOrWhiteSpace($health.version)) { return $false }
    $healthPid = 0
    if (![int]::TryParse([string]$health.pid, [ref]$healthPid)) { return $false }
    if ($null -eq (Get-VerifiedServerProcess $healthPid)) { return $false }
    $listener = Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $serverPort -OwningProcess $healthPid -ErrorAction SilentlyContinue
    return $null -ne $listener
}

function Test-WorkbenchHealth($health) {
    return $null -ne $health -and $health.buildId -ceq $expectedBuild -and (Test-WorkbenchIdentity $health)
}

function Restart-PreviousBackend($health) {
    # Browser windows own the UI state. Their EventSource reconnects to this
    # origin after the read-only market service is replaced.
    $previous = Get-Process -Id $health.pid -ErrorAction SilentlyContinue
    if ($null -eq $previous) { return }
    try {
        # Keep the handle to this specific process during the identity checks.
        $null = $previous.Handle
        if ($previous.HasExited) { return }
        if (!(Test-WorkbenchIdentity $health)) {
            if ($previous.HasExited) { return }
            throw '无法核对旧版后台的身份，请稍后重试。'
        }
        Write-LauncherLog ('Replacing verified previous backend PID ' + $previous.Id + ' (' + $health.activeWindows + ' sessions)')
        try { $previous.Kill() } catch {
            if (!$previous.HasExited) { throw }
        }
        if (!$previous.WaitForExit(8000)) { throw '旧版工作台后台未能及时退出，请重试。' }
    }
    finally { $previous.Dispose() }
}

function Write-LauncherLog([string]$message) {
    try {
        [void][IO.Directory]::CreateDirectory($logDirectory)
        $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $message + [Environment]::NewLine
        [IO.File]::AppendAllText((Join-Path $logDirectory 'launcher.log'), $line, [Text.UTF8Encoding]::new($true))
    } catch { }
}

try {
    foreach ($requiredPath in @($nodePath, $serverPath, $entryPath, $manifestPath)) {
        if (!(Test-Path -LiteralPath $requiredPath -PathType Leaf)) { throw ('程序文件缺失：' + $requiredPath + [Environment]::NewLine + '请保留完整的“趋势判断工作台”文件夹。') }
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Encoding UTF8 -Raw | ConvertFrom-Json
    $expectedBuild = [string]$manifest.buildId
    $serverPort = [int]$manifest.port
    if ($expectedBuild -cnotmatch '^[0-9a-f]{64}$' -or $serverPort -lt 1024 -or $serverPort -gt 65535) { throw '工作台构建信息不完整，请重新生成或解压程序。' }
    $appUrl = 'http://127.0.0.1:' + $serverPort + '/'
    $edgeCandidates = @()
    if (${env:ProgramFiles(x86)}) { $edgeCandidates += Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe' }
    if ($env:ProgramFiles) { $edgeCandidates += Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe' }
    if ($env:LOCALAPPDATA) { $edgeCandidates += Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe' }
    $edgePath = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (!$NoWindow -and !$edgePath) { throw '没有找到 Microsoft Edge，无法打开独立窗口。请先安装或修复 Windows 自带的 Edge。' }
    if ($CheckOnly) {
        [pscustomobject]@{ AppDirectory=$appDirectory; Runtime=$nodePath; Server=$serverPath; Browser=$edgePath; URL=$appUrl; BuildId=$expectedBuild }
        exit 0
    }
    Initialize-ArgumentParser
    $launchMutex = New-Object Threading.Mutex($false, ('Local\TrendWorkbenchLocal' + $serverPort))
    try { $ownsMutex = $launchMutex.WaitOne(45000) }
    catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (!$ownsMutex) {
        throw '上一次启动仍在处理中，请查看工作台启动日志。'
    }
    $health = Get-LocalHealth
    if (!(Test-WorkbenchHealth $health)) {
        if (Test-WorkbenchIdentity $health) {
            Restart-PreviousBackend $health
        }
        if (Test-LocalPortInUse) { throw ('本机端口 ' + $serverPort + ' 已由其他服务使用。请关闭占用端口的程序后重试。') }
        [void][IO.Directory]::CreateDirectory($logDirectory)
        $serverArguments = '"' + $serverPath + '" --port ' + $serverPort
        $startedProcess = Start-Process -FilePath $nodePath -ArgumentList $serverArguments -WorkingDirectory $appDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDirectory 'server.stdout.log') -RedirectStandardError (Join-Path $logDirectory 'server.stderr.log')
        Write-LauncherLog ('Starting local server PID ' + $startedProcess.Id)
        $deadline = [DateTime]::UtcNow.AddSeconds(40)
        $ready = $false
        do {
            if ($startedProcess.HasExited) { throw ('本机服务已退出，退出码：' + $startedProcess.ExitCode + '。请查看 logs\server.stderr.log。') }
            $health = Get-LocalHealth
            if (Test-WorkbenchHealth $health) { $ready = $true; break }
            if ($null -ne $health) { throw '端口返回的服务身份不匹配，未打开该页面。' }
            Start-Sleep -Milliseconds 250
        } while ([DateTime]::UtcNow -lt $deadline)
        if (!$ready) { throw '本机服务启动超过40秒。请查看 logs 文件夹内的日志后重试。' }
    }
    Write-LauncherLog ('Local server ready PID ' + $health.pid)
    if ($NoWindow) {
        [pscustomobject]@{ App='trend-workbench'; URL=$appUrl; ServerPid=$health.pid; Reused=($null -eq $startedProcess) }
    } else {
        Start-Process -FilePath $edgePath -ArgumentList ('--app="' + $appUrl + '"') -WindowStyle Normal
    }
}
catch {
    $failureMessage = $_.Exception.Message
    Write-LauncherLog ('ERROR ' + $failureMessage)
    if ($null -ne $startedProcess) {
        try {
            if (Get-VerifiedServerProcess $startedProcess.Id) { Stop-Process -Id $startedProcess.Id -ErrorAction SilentlyContinue }
        } catch { }
    }
    if (!$NoWindow -and !$CheckOnly) {
        $displayMessage = $failureMessage + [Environment]::NewLine + [Environment]::NewLine + '日志位置：' + $logDirectory
        try {
            Add-Type -AssemblyName System.Windows.Forms
            [void][Windows.Forms.MessageBox]::Show($displayMessage, '趋势判断工作台启动失败', [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Error)
        } catch {
            $popupShell = New-Object -ComObject WScript.Shell
            [void]$popupShell.Popup($displayMessage, 0, '趋势判断工作台启动失败', 16)
        }
    }
    Write-Error $failureMessage -ErrorAction Continue
    exit 1
}
finally {
    if ($ownsMutex -and $null -ne $launchMutex) { $launchMutex.ReleaseMutex() }
    if ($null -ne $launchMutex) { $launchMutex.Dispose() }
}
