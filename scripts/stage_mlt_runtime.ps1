param(
    [Parameter(Mandatory = $true)][string]$Archive,
    [Parameter(Mandatory = $true)][string]$Destination
)

$ErrorActionPreference = 'Stop'
$ExpectedSha256 = 'd704c12a8ce6d1fbe1a13155578ee5cf36b749a26503500cce38d8e68f900b0d'
if (!(Test-Path -LiteralPath $Archive -PathType Leaf)) {
    throw "MLT runtime archive not found: $Archive"
}
$ActualSha256 = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ActualSha256 -ne $ExpectedSha256) {
    throw "MLT runtime archive SHA-256 mismatch; expected $ExpectedSha256, received $ActualSha256."
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$RuntimeFiles = @(
    'avcodec-63.dll', 'avdevice-63.dll', 'avfilter-12.dll', 'avformat-63.dll', 'avutil-61.dll',
    'libaom.dll', 'libbz2-1.dll', 'libdav1d.dll', 'libdl.dll', 'libgcc_s_seh-1.dll', 'libiconv-2.dll',
    'liblzma-5.dll', 'libmlt-7.dll', 'libmp3lame-0.dll', 'libmpg123-0.dll', 'libogg-0.dll', 'libopus-0.dll',
    'libsharpyuv-0.dll', 'libstdc++-6.dll', 'libSvtAv1Enc-4.dll', 'libtheoradec-2.dll', 'libtheoraenc-2.dll',
    'libvmaf.dll', 'libvpl-2.dll', 'libvorbis-0.dll', 'libvorbisenc-2.dll', 'libvpx-1.dll', 'libwebp-7.dll',
    'libwebpmux-3.dll', 'libwinpthread-1.dll', 'libx264-165.dll', 'libx265-217.dll', 'libxml2-16.dll',
    'libz-1.dll', 'libzimg-2.dll', 'swresample-7.dll', 'swscale-10.dll', 'zlib1.dll',
    'lib/mlt/libmltavformat.dll', 'lib/mlt/libmltcore.dll', 'lib/mlt/libmltplus.dll', 'lib/mlt/libmltxml.dll'
)

$ResolvedDestination = [IO.Path]::GetFullPath($Destination)
$DestinationPrefix = $ResolvedDestination.TrimEnd('\') + '\'
$Zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
    $Entries = @{}
    foreach ($Entry in $Zip.Entries) {
        $Entries[$Entry.FullName.ToLowerInvariant()] = $Entry
    }

    $RelativeFiles = @($RuntimeFiles) + @(
        $Zip.Entries |
            Where-Object { $_.FullName.StartsWith('Shotcut/share/mlt/', [StringComparison]::OrdinalIgnoreCase) -and !$_.FullName.EndsWith('/') } |
            ForEach-Object { $_.FullName.Substring('Shotcut/'.Length) }
    ) + @('LICENSE', 'COPYING.txt')

    foreach ($RelativeFile in $RelativeFiles) {
        $ArchivePath = 'Shotcut/' + $RelativeFile.Replace('\', '/')
        $Entry = $Entries[$ArchivePath.ToLowerInvariant()]
        if (!$Entry) {
            if ($RelativeFile -in @('LICENSE', 'COPYING.txt')) { continue }
            throw "Required MLT runtime component missing: $RelativeFile"
        }

        $Target = [IO.Path]::GetFullPath((Join-Path $ResolvedDestination $RelativeFile.Replace('/', '\')))
        if (!$Target.StartsWith($DestinationPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to extract a path outside the MLT runtime directory: $RelativeFile"
        }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Target) | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($Entry, $Target, $true)
    }
} finally {
    $Zip.Dispose()
}

$RuntimeSize = (Get-ChildItem -LiteralPath $ResolvedDestination -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("MLT runtime staged: {0} MiB" -f [Math]::Round($RuntimeSize / 1MB, 1))
