param([Parameter(Mandatory = $true)][string]$Timestamp)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$AppSource = Join-Path $Root 'release\剪辑助手'
$StagingRoot = Join-Path $Root ".build\github-release\ClipAssistant-installer-$Timestamp"
$ArchiveRoot = Join-Path $Root 'release\archives'
$ArchivePath = Join-Path $ArchiveRoot "ClipAssistant-installer-$Timestamp.zip"
$AllowedStageRoot = [IO.Path]::GetFullPath((Join-Path $Root '.build\github-release')).TrimEnd('\') + '\'
$ResolvedStage = [IO.Path]::GetFullPath($StagingRoot)
if (!$ResolvedStage.StartsWith($AllowedStageRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw '安装包暂存路径越界。'
}
if (!(Test-Path -LiteralPath (Join-Path $AppSource '剪辑助手.exe') -PathType Leaf)) {
    throw '安装包源文件缺失。'
}
if ((Test-Path -LiteralPath $StagingRoot) -or (Test-Path -LiteralPath $ArchivePath)) {
    throw '安装包暂存目录或版本文件已存在。'
}

New-Item -ItemType Directory -Force -Path $StagingRoot, $ArchiveRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $StagingRoot 'release') | Out-Null
Copy-Item -LiteralPath $AppSource -Destination (Join-Path $StagingRoot 'release\剪辑助手') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $Root '安装剪辑助手.bat') -Destination $StagingRoot -Force
Copy-Item -LiteralPath (Join-Path $Root '安装剪辑助手.ps1') -Destination $StagingRoot -Force
Copy-Item -LiteralPath (Join-Path $AppSource 'README.md') -Destination $StagingRoot -Force

$Readme = @'
剪辑助手独立安装包

1. 完整解压 ZIP 文件。
2. 双击“安装剪辑助手.bat”。
3. 安装程序会将软件复制到当前 Windows 用户的 Programs 目录，并创建开始菜单快捷方式。

此安装包包含完整应用运行文件，不需要先下载或安装便携版。项目、设置和凭据数据不会打入包中。
'@
[IO.File]::WriteAllText((Join-Path $StagingRoot '安装说明.txt'), $Readme, [Text.Encoding]::UTF8)
$ExeHash = (Get-FileHash -LiteralPath (Join-Path $AppSource '剪辑助手.exe') -Algorithm SHA256).Hash
$Name = "ClipAssistant-installer-$Timestamp"
$Created = [DateTime]::ParseExact($Timestamp, 'yyyyMMdd-HHmmss', [Globalization.CultureInfo]::InvariantCulture)
$Created = [TimeZoneInfo]::ConvertTime($Created, [TimeZoneInfo]::FindSystemTimeZoneById('New Zealand Standard Time'))
$Manifest = [ordered]@{
    version = $Name
    createdAtPacificAuckland = $Created.ToString('yyyy-MM-dd HH:mm:ss zzz')
    sourceCommit = (git -C $Root rev-parse HEAD)
    executableSha256 = $ExeHash
    python = '3.14.10'
    ffmpeg = '9.0.2'
    ffprobe = '9.0.2'
    node = 'v22.23.5'
    undici = '6.29.1'
    userDataIncluded = $false
    credentialSeedIncluded = $false
}
$Manifest | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $StagingRoot '版本清单.json') -Encoding UTF8

$ForbiddenNames = @('canva-page-audit.json', 'custom-colors.json', 'Canva本地页面信息.html', 'Canva本地页面信息.md', '.buildpage_flash_stats.txt')
$PrivateFiles = @(Get-ChildItem -LiteralPath $StagingRoot -Recurse -File | Where-Object {
    $_.FullName -match '[\\/]credential-seed[\\/]' -or
    $_.FullName -match '[\\/]user-seed[\\/]' -or
    $_.Name -in $ForbiddenNames
})
if ($PrivateFiles.Count -gt 0) {
    throw ('拒绝打包个人种子/缓存：' + ($PrivateFiles.FullName -join '; '))
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($StagingRoot, $ArchivePath, [IO.Compression.CompressionLevel]::Optimal, $false)
$Zip = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
try {
    $Entries = @($Zip.Entries | Where-Object { !$_.FullName.EndsWith('/') })
    $Expected = (Get-ChildItem -LiteralPath $StagingRoot -Recurse -File | Measure-Object).Count
    if ($Entries.Count -ne $Expected) { throw "安装包文件数量校验失败：$($Entries.Count) / $Expected" }
    foreach ($Entry in $Entries) {
        $Stream = $Entry.Open()
        try { $Stream.CopyTo([IO.Stream]::Null) } finally { $Stream.Dispose() }
    }
    $ForbiddenEntries = @($Entries | Where-Object {
        $_.FullName -match '[\\/]credential-seed[\\/]' -or
        $_.FullName -match '[\\/]user-seed[\\/]' -or
        [IO.Path]::GetFileName($_.FullName) -in $ForbiddenNames
    })
    if ($ForbiddenEntries.Count -gt 0) { throw '安装 ZIP 中发现私有缓存。' }
} finally { $Zip.Dispose() }

$Hash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash
[IO.File]::WriteAllText("$ArchivePath.sha256", "$Hash  $([IO.Path]::GetFileName($ArchivePath))`r`n", [Text.Encoding]::ASCII)
[pscustomobject]@{
    InstallerArchive = $ArchivePath
    Files = $Entries.Count
    SizeMB = [math]::Round((Get-Item -LiteralPath $ArchivePath).Length / 1MB, 1)
    Sha256 = $Hash
    ExeSha256 = $ExeHash
    SourceCommit = (git -C $Root rev-parse HEAD)
} | Format-List
