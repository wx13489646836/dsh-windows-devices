param([switch]$Unattended)
$ErrorActionPreference='Stop'
$Root=Join-Path $env:ProgramData 'DshWindowsDevices'
$StateFile=Join-Path $Root 'state.json'
$ServiceName='DshWindowsSSH'
$RuleName='DSH-Windows-SSH-2222'
$pair=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAIR_BASE64__'))|ConvertFrom-Json
$success=$false
function Set-DshKeyAcl([string]$Path) {
 # Start with an empty DACL: /grant:r only replaces entries for the named SIDs.
 $acl=New-Object Security.AccessControl.FileSecurity
 $acl.SetAccessRuleProtection($true,$false)
 foreach($sidText in @('S-1-5-18','S-1-5-32-544')){
  $sid=New-Object Security.Principal.SecurityIdentifier($sidText)
  $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow)
  [void]$acl.AddAccessRule($rule)
 }
 [IO.File]::SetAccessControl($Path,$acl)
 $actual=Get-Acl -LiteralPath $Path
 $rules=@($actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
 $valid=$actual.AreAccessRulesProtected -and $rules.Count -eq 2
 foreach($rule in $rules){
  if($rule.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544') -or $rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl){$valid=$false}
 }
 if(-not $valid){throw ('SSH key ACL verification failed: '+[IO.Path]::GetFileName($Path))}
}
function Resolve-OpenSsh {
 # Reuse the executable of a working OpenSSH service when multiple versions are installed.
 $existing=Get-CimInstance Win32_Service -Filter "Name='sshd'" -ErrorAction SilentlyContinue
 if($existing -and $existing.State -eq 'Running'){
  $match=[regex]::Match($existing.PathName,'^\s*(?:"([^"]+\.exe)"|(.+?\.exe))(?:\s|$)')
  if($match.Success){
   $candidate=if($match.Groups[1].Success){$match.Groups[1].Value}else{$match.Groups[2].Value}
   if([IO.Path]::GetFileName($candidate) -eq 'sshd.exe' -and (Test-Path -LiteralPath $candidate)){return $candidate}
  }
 }
 return (Join-Path $env:WINDIR 'System32\OpenSSH\sshd.exe')
}
try {
 $principal=[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
 if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw '请以管理员身份运行。'}
 $account=Get-LocalUser -Name $env:USERNAME -ErrorAction SilentlyContinue
 if(-not $account -or -not $account.Enabled){throw '请使用本机已启用的本地管理员账户运行接入程序。'}
 Write-Host 'DSH Windows 设备接入' -ForegroundColor Cyan
 $previous=if(Test-Path $StateFile){Get-Content -LiteralPath $StateFile -Raw|ConvertFrom-Json}else{$null}
 if((Get-NetTCPConnection -LocalPort 2222 -State Listen -ErrorAction SilentlyContinue) -and -not(Get-Service $ServiceName -ErrorAction SilentlyContinue)){throw '端口 2222 已被其他程序使用，请释放后重试。'}
 New-Item -ItemType Directory -Path $Root -Force|Out-Null
 & icacls.exe $Root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
 if($LASTEXITCODE -ne 0){throw '无法设置设备配置目录权限。'}
 [IO.File]::WriteAllBytes((Join-Path $Root 'maintain.ps1'),[Convert]::FromBase64String('__MAINTAIN_BASE64__'))
 # Load only helper functions, not the maintenance entry point.
 $helper=Get-Content -LiteralPath (Join-Path $Root 'maintain.ps1') -Raw
 $helper=$helper.Substring($helper.IndexOf('function Write-Log'),$helper.IndexOf('$mutex=')-$helper.IndexOf('function Write-Log'))
 . ([scriptblock]::Create($helper))
 $wifi=Find-Wifi $pair
 if(-not $wifi){throw '请先连接这台移动 WiFi，并确认 DSH 正常运行。'}
 $reuse=$false
 if($previous -and -not $previous.revoked -and $previous.server -eq $pair.server -and $previous.pin -eq $pair.pin){
  try {
   $priorReply=Send-Dsh $previous '/heartbeat' @{id=$previous.id;token=$previous.deviceToken}
   $reuse=$priorReply.action -ne 'revoke'
  } catch {
   if($_.Exception.Message -notmatch '设备认证失败'){throw}
   Write-Host '检测到上次未完成的安装，正在重新接入……'
  }
 }
 Write-Host '正在检查 Windows OpenSSH……'
 $sshd=Resolve-OpenSsh
 if(-not(Test-Path $sshd)){
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
  if(-not(Test-Path $sshd)){throw 'OpenSSH 安装未完成；请完成 Windows 可选功能安装后重新运行。'}
 }
 Write-Host ('使用 OpenSSH：'+$sshd)
 $sshHome=Split-Path $sshd
 $hostKey=Join-Path $Root 'ssh_host_ed25519_key'
 Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
 if(-not(Test-Path $hostKey)){
  & (Join-Path $sshHome 'ssh-keygen.exe') -q -t ed25519 -f $hostKey -N '""'
  if($LASTEXITCODE -ne 0){throw '无法生成 SSH 主机密钥。'}
 }
 if(-not $reuse){[IO.File]::WriteAllText((Join-Path $Root 'authorized_keys'),($pair.publicKey+"`n"),[Text.Encoding]::ASCII)}
 foreach($p in @($hostKey,(Join-Path $Root 'authorized_keys'))){
  Set-DshKeyAcl $p
  # /setowner is a separate icacls operation; it cannot be combined with /grant or /inheritance.
  & icacls.exe $p /setowner '*S-1-5-18' | Out-Null
  if($LASTEXITCODE -ne 0){throw ('SSH 密钥所有者设置失败：'+[IO.Path]::GetFileName($p))}
  if((Get-Acl -LiteralPath $p).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-18'){throw 'SSH key owner verification failed'}
 }
 $configFile=Join-Path $Root 'sshd_config'
 $unixRoot=$Root.Replace('\','/')
 $sshConfig=@"
Port 2222
AddressFamily inet
HostKey $unixRoot/ssh_host_ed25519_key
AuthorizedKeysFile $unixRoot/authorized_keys
PubkeyAuthentication yes
PasswordAuthentication no
PermitEmptyPasswords no
AllowUsers $($env:USERNAME.ToLowerInvariant())
StrictModes yes
AllowTcpForwarding no
AllowAgentForwarding no
PermitTunnel no
Subsystem sftp "$($sshHome.Replace('\','/'))/sftp-server.exe"
"@
 [IO.File]::WriteAllText($configFile,$sshConfig,[Text.Encoding]::ASCII)
 & $sshd -t -f $configFile
 if($LASTEXITCODE -ne 0){throw 'SSH 配置检查失败。'}
 $binary='"'+$sshd+'" -D -f "'+$configFile+'" -E "'+(Join-Path $Root 'sshd.log')+'"'
 $service=Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
 if($service){
  $changed=Invoke-CimMethod -InputObject $service -MethodName Change -Arguments @{PathName=$binary;StartMode='Manual'}
  if($changed.ReturnValue -ne 0){throw ('SSH 服务配置更新失败，代码：'+$changed.ReturnValue)}
 }else{New-Service -Name $ServiceName -BinaryPathName $binary -DisplayName 'DSH Windows SSH' -StartupType Manual|Out-Null}
 $secret=New-Object byte[] 32;[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($secret)
 $deviceToken=([BitConverter]::ToString($secret)).Replace('-','').ToLowerInvariant()
 $state=if($reuse){$previous}else{[pscustomobject]@{id=$pair.id;server=$pair.server;pin=$pair.pin;gateway=$pair.gateway;username=$env:USERNAME;deviceToken=$deviceToken;paused=$false;revoked=$false}}
 $state.paused=$false
 Write-Host '正在启动 DSH SSH 服务……'
 Enable-Dsh $state $wifi
 $public=(Get-Content -LiteralPath ($hostKey+'.pub') -Raw).Trim().Split(' ')[1]
 Write-Host '正在向 DSH 登记并验证设备……'
 if(-not $reuse){Send-Dsh $state '/register' @{id=$pair.id;token=$pair.pairingToken;deviceToken=$deviceToken;hostname=$env:COMPUTERNAME;username=$env:USERNAME;port=2222;hostKey=$public}|Out-Null}
 Save-State $state
 $ps=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
 $args='-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $Root 'maintain.ps1')+'"'
 $taskAction=New-ScheduledTaskAction -Execute $ps -Argument $args
 $triggers=@((New-ScheduledTaskTrigger -AtStartup),(New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)))
 $settings=New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 50) -StartWhenAvailable
 Register-ScheduledTask -TaskName 'DshWindowsDevices-Check' -Action $taskAction -Trigger $triggers -Settings $settings -User SYSTEM -RunLevel Highest -Force|Out-Null
 $escaped=[Security.SecurityElement]::Escape($args)
 $eventXml=@"
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><EventTrigger><Enabled>true</Enabled><Subscription>&lt;QueryList&gt;&lt;Query Id="0" Path="Microsoft-Windows-NetworkProfile/Operational"&gt;&lt;Select Path="Microsoft-Windows-NetworkProfile/Operational"&gt;*[System[(EventID=10000 or EventID=10001)]]&lt;/Select&gt;&lt;/Query&gt;&lt;/QueryList&gt;</Subscription></EventTrigger></Triggers><Principals><Principal id="System"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><Hidden>true</Hidden><ExecutionTimeLimit>PT50S</ExecutionTimeLimit></Settings><Actions Context="System"><Exec><Command>$ps</Command><Arguments>$escaped</Arguments></Exec></Actions></Task>
"@
 Register-ScheduledTask -TaskName 'DshWindowsDevices-Network' -Xml $eventXml -Force|Out-Null
 $menu=Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\DSH Windows 设备'
 New-Item -ItemType Directory -Path $menu -Force|Out-Null
 foreach($item in @(@('停用','Pause'),@('恢复','Resume'),@('卸载接入','Uninstall'))){
  $target=Join-Path $Root 'maintain.ps1'
  $line='@echo off'+"`r`n"+'powershell.exe -NoProfile -Command "Start-Process powershell.exe -Verb RunAs -ArgumentList ''-NoProfile -ExecutionPolicy Bypass -File \"'+$target+'\" -Action '+$item[1]+''' -Wait"'+"`r`n"
  [IO.File]::WriteAllText((Join-Path $menu ($item[0]+'.cmd')),$line,[Text.Encoding]::ASCII)
 }
 $finalReply=Send-Dsh $state '/heartbeat' @{id=$state.id;token=$state.deviceToken}
 if($finalReply.action -ne 'enable'){Stop-Dsh;Write-Host '设备在 DSH 中已停用或解绑，请回设备页检查。'}
 Write-Host '接入完成。请返回 DSH → 设置 → Windows 设备，等待“在线 · SSH 已验证”，然后选择“用于当前对话”。' -ForegroundColor Green
 Write-Host '以后连接此 WiFi 会自动上线；开始菜单中的 DSH Windows 设备可以停用或卸载。'
 $success=$true
}catch{
 Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
 Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue|Disable-NetFirewallRule -ErrorAction SilentlyContinue|Out-Null
 Write-Host ('接入未完成：'+$_.Exception.Message) -ForegroundColor Red
 $sshLog=Join-Path $Root 'sshd.log'
 if(Test-Path $sshLog){Write-Host 'SSH 启动日志：';Get-Content -LiteralPath $sshLog -Tail 12 -ErrorAction SilentlyContinue|ForEach-Object {Write-Host $_}}
 if(Test-Path $Root){[IO.File]::WriteAllText((Join-Path $Root 'setup-error.txt'),($_|Out-String),[Text.UTF8Encoding]::new($false))}
}finally{if(-not $Unattended){Read-Host '按回车关闭窗口'|Out-Null};if(-not $success){exit 1}}
