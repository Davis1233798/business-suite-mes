const {app,BrowserWindow,session,dialog}=require('electron');
const {spawn}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
const {desktopPaths}=require('./paths.cjs');
const dataPaths=desktopPaths(app.getPath('appData'));
fs.mkdirSync(dataPaths.userData,{recursive:true});
app.setPath('userData',dataPaths.userData);
let backend,window;
app.enableSandbox();
if(!app.requestSingleInstanceLock())app.quit();
app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.focus()}});
async function startBackend(){
 const resources=app.isPackaged?process.resourcesPath:path.resolve(__dirname,'..');
 const binary=app.isPackaged?path.join(resources,'backend','business-suite.exe'):path.join(resources,'outputs','go',process.platform==='win32'?'business-suite.exe':'business-suite');
 const assets=app.isPackaged?path.join(resources,'web'):path.join(resources,'web-dist');
 if(!fs.existsSync(binary))throw new Error('找不到 Go 後端，請先執行 npm run desktop:prepare');
 return new Promise((resolve,reject)=>{backend=spawn(binary,[],{windowsHide:true,env:{...process.env,SUITE_ADDR:'127.0.0.1:0',SUITE_DB:dataPaths.database,SUITE_WEB:assets},stdio:['ignore','pipe','pipe']});
  const timeout=setTimeout(()=>reject(new Error('Go 後端啟動逾時')),20000);let buffer='';
  const output=data=>{buffer=(buffer+data.toString()).slice(-8192);const match=buffer.match(/Go business-suite ready at (127\.0\.0\.1:\d+)/);if(match){clearTimeout(timeout);resolve('http://'+match[1])}};
  backend.stdout.on('data',output);backend.stderr.on('data',output);backend.once('error',e=>{clearTimeout(timeout);reject(e)});backend.once('exit',code=>{clearTimeout(timeout);if(!window)reject(new Error('Go 後端提前結束：'+code));else if(!app.isQuitting)dialog.showErrorBox('後端連線中斷','請重新啟動 Business Suite。')});
 });
}
app.whenReady().then(async()=>{try{const origin=await startBackend();session.defaultSession.setPermissionRequestHandler((_w,_p,callback)=>callback(false));session.defaultSession.setPermissionCheckHandler(()=>false);
 window=new BrowserWindow({width:1440,height:960,minWidth:360,minHeight:600,title:'ForgeFlow MES',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false}});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',(event,url)=>{try{if(new URL(url).origin!==origin)event.preventDefault()}catch{event.preventDefault()}});
 window.webContents.on('will-attach-webview',event=>event.preventDefault());await window.loadURL(origin);window.on('closed',()=>{window=null});
 }catch(e){dialog.showErrorBox('啟動失敗',e.message);app.quit()}});
app.on('before-quit',()=>{app.isQuitting=true;if(backend)backend.kill()});app.on('window-all-closed',()=>app.quit());
