# Delete FlorianElmazi Credentials (Windows)

# PowerShell script that uses Windows API CredDelete to remove credentials
# that cmdkey can't delete because the target name contains hyphens.

$target = "LegacyGeneric:target=GitHub - https://api.github.com/FlorianElmazi"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CredMan {
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredDelete(string TargetName, int Type, int Flags);
}
"@

$result = [CredMan]::CredDelete($target, 1, 0)
Write-Host "CredDelete result: $result"

# Verify
cmdkey /list | Select-String "Florian"
Write-Host "Done - run: git config --global user.name ffazecaldy"
