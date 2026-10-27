import { execFileSync } from 'node:child_process'
const ps = [
  '$sig = @"',
  'using System; using System.Runtime.InteropServices;',
  'public class Cred {',
  '  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
  '  public static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);',
  '  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);',
  '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]',
  '  public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;',
  '    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;',
  '    public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }',
  '}',
  '"@','Add-Type -TypeDefinition $sig',
  'foreach ($t in @("git:https://github.com", "GitHub for Visual Studio - https://KamishiroRei@github.com/")) {',
  '  $p = [IntPtr]::Zero',
  '  if ([Cred]::CredReadW($t, 1, 0, [ref]$p)) {',
  '    $c = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][Cred+CREDENTIAL])',
  '    if ($c.CredentialBlobSize -gt 0) { $b = New-Object byte[] $c.CredentialBlobSize; [Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $b, 0, $c.CredentialBlobSize); Write-Output ([Text.Encoding]::Unicode.GetString($b)) }',
  '    [Cred]::CredFree($p) } }',
].join('\n')
const TOKEN = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
const H = { Authorization: 'token ' + TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'x' }
const res = await fetch('https://api.github.com/repos/KamishiroRei/dsh-sillytavern/contents/README.md', {
  method: 'PUT',
  headers: H,
  body: JSON.stringify({ message: 'chore: 初始化仓库', content: Buffer.from('# dsh-sillytavern\n').toString('base64') }),
})
console.log('seed status:', res.status, (await res.text()).slice(0, 200))
