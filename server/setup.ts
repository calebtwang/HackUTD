import { Router } from 'express';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import { root } from './config.js';

export const setupRouter=Router();
const keys=['MODEL_BASE_URL','MODEL_NAME','MODEL_API_KEY','ELEVENLABS_API_KEY','ELEVENLABS_WEBHOOK_SECRET','PHOTON_API_KEY','PHOTON_PROJECT_ID'];
setupRouter.get('/setup',(_req,res)=>{
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Setup</title>
<style>body{font:14px Arial,sans-serif;background:#fff;color:#222;margin:20px}nav{display:flex;flex-wrap:wrap;gap:16px;border-bottom:1px solid #ccc;padding-bottom:12px}a{color:#164e91}main{max-width:650px}h1{font-size:24px;margin:22px 0 14px}h2{font-size:18px}form{border-top:1px solid #ccc;padding:12px 0 18px}label{display:block;margin:10px 0 4px}input{box-sizing:border-box;width:100%;max-width:500px;padding:5px;border:1px solid #888;font:inherit}button{font:inherit;padding:5px 10px;margin-top:12px}p{line-height:1.5}input:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid #164e91;outline-offset:2px}</style></head>
<body><nav aria-label="Main navigation"><a href="/">Dashboard</a><a href="/evidence">Evidence</a><a href="/forum">Forum</a><a href="/admin">Collected numbers</a><a href="/setup" aria-current="page">Setup</a></nav>
<main><h1>Setup</h1><p>Credentials are saved in this demo's local configuration and are never displayed here. Leave a field blank to keep its current value.</p>
<form method="POST" action="/api/setup/credentials"><h2>Discovery model</h2><label for="base">API base URL</label><input id="base" name="MODEL_BASE_URL" type="url" autocomplete="off"><label for="model">Model name</label><input id="model" name="MODEL_NAME" autocomplete="off"><label for="modelkey">Model API key</label><input id="modelkey" name="MODEL_API_KEY" type="password" autocomplete="new-password"><br><button>Save model connection</button></form>
<form method="POST" action="/api/setup/credentials"><h2>ElevenLabs</h2><label for="elevenkey">API key</label><input id="elevenkey" name="ELEVENLABS_API_KEY" type="password" autocomplete="new-password"><br><button>Save ElevenLabs connection</button></form>
<form method="POST" action="/api/setup/credentials"><h2>Photon</h2><label for="photonproject">Project ID</label><input id="photonproject" name="PHOTON_PROJECT_ID" autocomplete="off"><label for="photonkey">API key</label><input id="photonkey" name="PHOTON_API_KEY" type="password" autocomplete="new-password"><br><button>Save Photon connection</button></form></main></body></html>`);
});
setupRouter.post('/api/setup/credentials',(req,res)=>{
  const filename=path.join(root,'.env');
  const existing=existsSync(filename)?parse(readFileSync(filename)):{};
  let changed=0;
  for(const key of keys){
    const value=req.body?.[key];
    if(typeof value==='string'&&value.trim()){
      if(value.length>16000 || /[\r\n]/.test(value)) {res.status(400).send('Invalid configuration value.');return;}
      existing[key]=value.trim();changed++;
    }
  }
  if(!changed){res.status(400).send('No values were supplied.');return;}
  writeFileSync(filename,Object.entries(existing).map(([key,value])=>`${key}=${JSON.stringify(value)}`).join('\n')+'\n',{mode:0o600});
  chmodSync(filename,0o600);
  for(const [key,value] of Object.entries(existing)) process.env[key]=value;
  res.type('html').send('<!doctype html><html><title>Connection saved</title><body style="font:14px Arial,sans-serif;margin:20px"><h1>Connection saved locally</h1><p>The secret has not been included in this page.</p><a href="/setup">Back to connections</a> | <a href="/">Open dashboard</a></body></html>');
});
