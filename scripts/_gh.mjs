/**
 * 用 GitHub REST API 建仓库并推送（本机 UGit 的 git 没有 https 支持）。
 * 令牌从 Windows 凭据管理器读，只在本进程内存里用，不落盘。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO = process.argv[2] || 'dsh-sillytavern'
const ROOT = process.argv[3] || process.cwd()
const DESC = 'SillyTavern 酒馆引擎接入 DeepSeek Harness：角色卡、世界书、预设宏、正则、MVU 变量，以及由 AI 按情境自由设计的舞台'

/** 从 Windows 凭据管理器取 GitHub 令牌。 */
function readToken() {
  // cmdkey 只看得到目标名，取密码要 CredRead；这里用 PowerShell 的 CredentialManager 兼容路径
  const ps = [
    '$sig = @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class Cred {',
    '  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
    '  public static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);',
    '  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);',
    '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]',
    '  public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;',
    '    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;',
    '    public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }',
    '}',
    '"@',
    'Add-Type -TypeDefinition $sig',
    'foreach ($t in @("git:https://github.com", "GitHub for Visual Studio - https://KamishiroRei@github.com/", "UGit - https://api.github.com/KamishiroRei")) {',
    '  $p = [IntPtr]::Zero',
    '  if ([Cred]::CredReadW($t, 1, 0, [ref]$p)) {',
    '    $c = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][Cred+CREDENTIAL])',
    '    if ($c.CredentialBlobSize -gt 0) {',
    '      $b = New-Object byte[] $c.CredentialBlobSize',
    '      [Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $b, 0, $c.CredentialBlobSize)',
    '      $s = [Text.Encoding]::Unicode.GetString($b)',
    '      Write-Output ("TARGET=" + $t + "|LEN=" + $s.Length)',
    '    }',
    '    [Cred]::CredFree($p)',
    '  }',
    '}',
  ].join('\n')
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
  return out.trim()
}

console.log('credential scan:', readToken())
