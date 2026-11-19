param([Parameter(Mandatory = $true)][ValidatePattern('^\d{8}-\d{6}$')][string]$Timestamp)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Baseline = Join-Path $Root 'release\剪辑助手'
$ProgramsInstallRoot = Join-Path $env:LOCALAPPDATA 'Programs\剪辑助手'
$TimeZone = [TimeZoneInfo]::FindSystemTimeZoneById('New Zealand Standard Time')
$LocalTime = [DateTime]::ParseExact($Timestamp, 'yyyyMMdd-HHmmss', [Globalization.CultureInfo]::InvariantCulture)
$LocalTime = [TimeZoneInfo]::ConvertTime($LocalTime, $TimeZone)
$Timestamp = $LocalTime.ToString('yyyyMMdd-HHmmss')
$Name = "ClipAssistant-portable-$Timestamp"
$StagingRoot = Join-Path $Root ".build\github-release\$Name"
$AppTarget = Join-Path $StagingRoot 'release\剪辑助手'
$ArchiveRoot = Join-Path $Root 'release\archives'
$ArchivePath = Join-Path $ArchiveRoot "$Name.zip"

if (!(Test-Path -LiteralPath (Join-Path $Baseline '剪辑助手.exe') -PathType Leaf)) {
    throw "完整基线安装包不存在：$Baseline"
}
if (Test-Path -LiteralPath $StagingRoot) { throw "打包暂存目录已存在：$StagingRoot" }
if (Test-Path -LiteralPath $ArchivePath) { throw "版本压缩包已存在：$ArchivePath" }

New-Item -ItemType Directory -Force -Path (Split-Path $AppTarget -Parent), $ArchiveRoot | Out-Null
Copy-Item -LiteralPath $Baseline -Destination $AppTarget -Recurse -Force
Copy-Item -LiteralPath (Join-Path $Root '安装剪辑助手.bat') -Destination $StagingRoot -Force
Copy-Item -LiteralPath (Join-Path $Root '安装剪辑助手.ps1') -Destination $StagingRoot -Force
$PrivatePackageFiles = @(Get-ChildItem -LiteralPath $AppTarget -Recurse -File | Where-Object {
    $_.FullName -match '[\\/]credential-seed[\\/]' -or
    $_.FullName -match '[\\/]user-seed[\\/]' -or
    $_.Name -in @('canva-page-audit.json','custom-colors.json','Canva本地页面信息.html','Canva本地页面信息.md')
})
if ($PrivatePackageFiles.Count -gt 0) {
    throw ("拒绝打包本机凭据种子或用户缓存：" + ($PrivatePackageFiles.FullName -join '; '))
}

$LauncherLines = @(
    '@echo off',
    'setlocal',
    'chcp 65001 >nul',
    'set "APP=%~dp0release\剪辑助手\剪辑助手.exe"',
    'if not exist "%APP%" (',
    '  echo 未找到剪辑助手程序，请确认压缩包已完整解压。',
    '  pause',
    '  exit /b 1',
    ')',
    'start "" "%APP%"',
    'endlocal'
)
[IO.File]::WriteAllLines((Join-Path $StagingRoot '启动剪辑助手.bat'), $LauncherLines, [Text.Encoding]::ASCII)

$Readme = @"
剪辑助手便携版 $Timestamp

快速启动
1. 完整解压本压缩包，不要只提取 exe 文件。
2. 双击“启动剪辑助手.bat”，或直接运行 release\剪辑助手\剪辑助手.exe。

安装到本机
双击“安装剪辑助手.bat”。安装后可从开始菜单启动。

说明
- 本包包含完整 Windows x64 运行文件、内置素材和模型，无需安装 Python。
- 单独保留整个解压目录即可作为便携版使用。
- 工程、个人设置、API 凭据和本机缓存不包含在程序包中；首次使用 AI 服务需在本机配置自己的 API 凭据。
- 版本包名中的时间为新西兰当地时间。
"@
[IO.File]::WriteAllText((Join-Path $StagingRoot '使用说明.txt'), $Readme, [Text.Encoding]::UTF8)

$AppHash = (Get-FileHash -LiteralPath (Join-Path $AppTarget '剪辑助手.exe') -Algorithm SHA256).Hash
$SourceCommit = git -C $Root rev-parse HEAD
$Files = Get-ChildItem -LiteralPath $StagingRoot -Recurse -File
$Manifest = [ordered]@{
    version = $Name
    createdAtPacificAuckland = $LocalTime.ToString('yyyy-MM-dd HH:mm:ss zzz')
    sourceCommit = $SourceCommit
    executableSha256 = $AppHash
    packagedFileCount = $Files.Count + 1
    executable = 'release/剪辑助手/剪辑助手.exe'
    portableStart = '启动剪辑助手.bat'
    install = '安装剪辑助手.bat'
    userProjectDataIncluded = $false
    personalCredentialsIncluded = $false
    localSeedAndCacheDataIncluded = $false
    nodeVersion = (& (Join-Path $AppTarget '剪辑助手内核\runtime\node\node.exe') --version).Trim()
    undiciVersion = (& (Join-Path $AppTarget '剪辑助手内核\runtime\node\node.exe') -p 'process.versions.undici').Trim()
}
$Manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $StagingRoot '版本清单.json') -Encoding UTF8

Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory(
    $StagingRoot,
    $ArchivePath,
    [IO.Compression.CompressionLevel]::Optimal,
    $false
)

$Zip = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
try {
    $FileEntries = @($Zip.Entries | Where-Object {
        !$_.FullName.EndsWith('/') -and !$_.FullName.EndsWith([string][char]92)
    })
    $ExpectedCount = (Get-ChildItem -LiteralPath $StagingRoot -Recurse -File | Measure-Object).Count
    if ($FileEntries.Count -ne $ExpectedCount) {
        throw "压缩包文件数校验失败：$($FileEntries.Count) / $ExpectedCount"
    }
    $ForbiddenEntries = @($FileEntries | Where-Object {
        $_.FullName -match '[\\/]credential-seed[\\/]' -or
        $_.FullName -match '[\\/]user-seed[\\/]' -or
        [IO.Path]::GetFileName($_.FullName) -in @('canva-page-audit.json','custom-colors.json','Canva本地页面信息.html','Canva本地页面信息.md')
    })
    if ($ForbiddenEntries.Count -gt 0) {
        throw ("压缩包安全复检失败，包含本机种子/缓存文件：" + (($ForbiddenEntries | ForEach-Object FullName) -join '; '))
    }
    foreach ($Entry in $FileEntries) {
        $Stream = $Entry.Open()
        try { $Stream.CopyTo([IO.Stream]::Null) } finally { $Stream.Dispose() }
    }
} finally { $Zip.Dispose() }

$ArchiveHash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash
[IO.File]::WriteAllText(
    "$ArchivePath.sha256",
    "$ArchiveHash  $([IO.Path]::GetFileName($ArchivePath))`r`n",
    [Text.Encoding]::ASCII
)

$ResolvedStage = [IO.Path]::GetFullPath($StagingRoot)
$AllowedStageRoot = [IO.Path]::GetFullPath((Join-Path $Root '.build\github-release')).TrimEnd('\') + '\'
if (!$ResolvedStage.StartsWith($AllowedStageRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw '拒绝清理打包暂存目录之外的路径。'
}
Remove-Item -LiteralPath $ResolvedStage -Recurse -Force

$InstalledHash = $null
$InstalledExe = Join-Path $ProgramsInstallRoot '剪辑助手.exe'
if (Test-Path -LiteralPath $InstalledExe -PathType Leaf) {
    $InstalledHash = (Get-FileHash -LiteralPath $InstalledExe -Algorithm SHA256).Hash
}
[pscustomobject]@{
    Name = $Name
    ArchivePath = $ArchivePath
    Files = $FileEntries.Count
    ArchiveMB = [math]::Round((Get-Item -LiteralPath $ArchivePath).Length / 1MB, 1)
    ArchiveSha256 = $ArchiveHash
    ExecutableSha256 = $AppHash
    InstalledVersionMatches = ($InstalledHash -eq $AppHash)
    SourceCommit = $SourceCommit
} | Format-List
