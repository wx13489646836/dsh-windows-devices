param([ValidateSet('Check','Pause','Resume','Uninstall')][string]$Action='Check')
$ErrorActionPreference='Stop'
$Root=Join-Path $env:ProgramData 'DshWindowsDevices'
$StateFile=Join-Path $Root 'state.json'
$ServiceName='DshWindowsSSH'
$RuleName='DSH-Windows-SSH-2222'
$LogFile=Join-Path $Root 'maintenance.log'
function Write-Log($Text) { if((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 262144){[IO.File]::WriteAllText($LogFile,'')}; Add-Content -LiteralPath $LogFile -Value ((Get-Date -Format s)+' '+$Text) }
function Stop-Dsh { Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue | Disable-NetFirewallRule -ErrorAction SilentlyContinue | Out-Null; Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue }
function Save-State($State) { [IO.File]::WriteAllText($StateFile,($State|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false)) }
function Initialize-Tls {
 if(-not ('DshPinnedHttp' -as [type])) { Add-Type -TypeDefinition @'
using System;
using System.Net;
using System.IO;
using System.Text;
using System.Security.Cryptography;
public static class DshPinnedHttp {
 public static string Send(string url,string pin,string data) {
  var r=(HttpWebRequest)WebRequest.Create(url);
  r.Proxy=null;r.AllowAutoRedirect=false;r.Timeout=12000;r.ReadWriteTimeout=12000;
  r.ServerCertificateValidationCallback=(sender,cert,chain,errors)=>{
   if(cert==null)return false;
   using(var s=SHA256.Create()){return BitConverter.ToString(s.ComputeHash(cert.GetRawCertData())).Replace("-","").ToLowerInvariant()==pin;}
  };
  if(!String.IsNullOrEmpty(data)){r.Method="POST";r.ContentType="application/json";var b=Encoding.UTF8.GetBytes(data);r.ContentLength=b.Length;using(var stream=r.GetRequestStream()){stream.Write(b,0,b.Length);}}
  try {using(var response=r.GetResponse())using(var reader=new StreamReader(response.GetResponseStream(),Encoding.UTF8)){return reader.ReadToEnd();}}
  catch(WebException e) {
   var response=e.Response as HttpWebResponse;if(response==null)throw;
   using(response)using(var reader=new StreamReader(response.GetResponseStream(),Encoding.UTF8)){
    var detail=reader.ReadToEnd();if(detail.Length>4096)detail=detail.Substring(0,4096);
    throw new InvalidOperationException("DSH HTTP "+(int)response.StatusCode+": "+detail,e);
   }
  }
 }
}
'@ }
 [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
}
function Send-Dsh($State,$Path,$Body) { Initialize-Tls; $j=if($null -eq $Body){$null}else{$Body|ConvertTo-Json -Compress -Depth 5}; [DshPinnedHttp]::Send($State.server+$Path,$State.pin,$j)|ConvertFrom-Json }
function Find-Wifi($State) {
 $adapters=@(Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object {$_.Status -eq 'Up' -and ($_.PhysicalMediaType -eq 'Native 802.11' -or $_.NdisPhysicalMedium -eq 9 -or $_.InterfaceDescription -match 'Wireless|Wi-Fi|802\.11')})
 foreach($a in $adapters){
  $route=Get-NetRoute -InterfaceIndex $a.ifIndex -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Where-Object NextHop -eq $State.gateway | Select-Object -First 1
  if(-not $route){continue}
  $ip=Get-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {$_.IPAddress -like '192.168.0.*' -and $_.AddressState -eq 'Preferred'} | Select-Object -First 1
  if(-not $ip){continue}
  $identity=Send-Dsh $State '/identity' $null
  if($identity.service -eq 'dsh-windows-devices'){return @{ip=$ip.IPAddress;alias=$a.Name}}
 }
 return $null
}
function Enable-Dsh($State,$Wifi) {
 if(-not (Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name $RuleName -DisplayName 'DSH Windows SSH (paired WiFi only)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 2222 -RemoteAddress $State.gateway -LocalAddress $Wifi.ip -InterfaceAlias $Wifi.alias -Profile Any | Out-Null
 } else {
  $rule=Get-NetFirewallRule -Name $RuleName
  $rule|Get-NetFirewallAddressFilter|Set-NetFirewallAddressFilter -RemoteAddress $State.gateway -LocalAddress $Wifi.ip|Out-Null
  $rule|Set-NetFirewallRule -InterfaceAlias $Wifi.alias -Enabled True|Out-Null
 }
 Start-Service -Name $ServiceName
}
function Remove-Dsh {
 Stop-Dsh
 Unregister-ScheduledTask -TaskName 'DshWindowsDevices-Check' -Confirm:$false -ErrorAction SilentlyContinue
 Unregister-ScheduledTask -TaskName 'DshWindowsDevices-Network' -Confirm:$false -ErrorAction SilentlyContinue
 & sc.exe delete $ServiceName | Out-Null
 Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue|Remove-NetFirewallRule
 foreach($file in @('authorized_keys','ssh_host_ed25519_key','ssh_host_ed25519_key.pub')){ $p=Join-Path $Root $file; if(Test-Path $p){Remove-Item -LiteralPath $p -Force} }
 $state.revoked=$true;$state.paused=$true;Save-State $state
}
$mutex=[Threading.Mutex]::new($false,'Global\DshWindowsDevicesMaintain')
$locked=$false
try {
 $locked=$mutex.WaitOne(0);if(-not $locked){exit 0}
 if(-not(Test-Path $StateFile)){exit 0}; $state=Get-Content -LiteralPath $StateFile -Raw|ConvertFrom-Json
 switch($Action){
  'Pause' {$state.paused=$true;Save-State $state;Stop-Dsh;Write-Log 'Paused locally';exit 0}
  'Resume' {if($state.revoked){throw 'Device was unpaired. Download a new setup program.'};$state.paused=$false;Save-State $state}
  'Uninstall' {Remove-Dsh;Write-Log 'Local authorization removed';exit 0}
 }
 if($state.revoked){Stop-Dsh;exit 0}
 $wifi=Find-Wifi $state
 if(-not $wifi){Stop-Dsh;Write-Log 'Target WiFi unavailable';exit 0}
 $result=Send-Dsh $state '/heartbeat' @{id=$state.id;token=$state.deviceToken}
 if($result.action -eq 'revoke') {
  Remove-Dsh
  try{Send-Dsh $state '/heartbeat' @{id=$state.id;token=$state.deviceToken;cleanupDone=$true}|Out-Null}catch{}
  Write-Log 'Unpaired and keys removed';exit 0
 }
 if($state.paused -or $result.action -ne 'enable'){Stop-Dsh;exit 0}
 Enable-Dsh $state $wifi
 Write-Log 'Paired WiFi verified; SSH enabled'
}catch{Stop-Dsh;Write-Log $_.Exception.Message;exit 1}finally{if($locked){$mutex.ReleaseMutex()};$mutex.Dispose()}
