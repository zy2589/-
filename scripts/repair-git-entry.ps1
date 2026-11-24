$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$GitHistoryRoot = [IO.Path]::GetFullPath((Join-Path $Root '可清理数据\Git历史\.git'))
$DotGitPath = Join-Path $Root '.git'
$RootPrefix = $Root.TrimEnd('\') + '\'
if (!$GitHistoryRoot.StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Git 历史路径不在工程目录中。'
}
if (!(Test-Path -LiteralPath (Join-Path $GitHistoryRoot 'HEAD') -PathType Leaf)) {
    throw 'Git 历史不完整，未修改 .git 入口。'
}

if (Test-Path -LiteralPath $DotGitPath) {
    $Existing = Get-Item -LiteralPath $DotGitPath -Force
    if ($Existing.PSIsContainer) {
        $Children = @(Get-ChildItem -LiteralPath $DotGitPath -Force)
        if ($Children.Count -ne 0) { throw '.git 目录非空，未修改。' }
        Remove-Item -LiteralPath $DotGitPath
    } else {
        $CurrentPointer = [IO.File]::ReadAllText($DotGitPath).Trim()
        $ExpectedPointer = 'gitdir: ' + $GitHistoryRoot.Replace('\','/')
        if ($CurrentPointer -ne $ExpectedPointer) { throw '.git 指针指向其他位置，未修改。' }
    }
}

$Pointer = 'gitdir: ' + $GitHistoryRoot.Replace('\','/')
[IO.File]::WriteAllText($DotGitPath, $Pointer, [System.Text.UTF8Encoding]::new($false))
[IO.File]::SetAttributes($DotGitPath, [IO.FileAttributes]::Hidden)
& git "--git-dir=$GitHistoryRoot" config --local core.worktree $Root
if ($LASTEXITCODE -ne 0) { throw 'Git 工作目录配置失败。' }
$Head = (& git -C $Root rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Git 入口校验失败。' }
Write-Output "Git 入口已修复：$Head"
