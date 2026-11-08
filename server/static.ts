import express, { type Express } from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { staticAssetPath } from './hosting.js';

const PAGES=new Set(['/','/debug','/forum','/phishing','/demo/benign-event','/demo/benign-news']);
/** Serve compiled artifacts only. Unknown paths never fall through to the source tree. */
export function mountProductionFrontend(app:Express,dist:string) {
  const index=path.join(dist,'index.html');
  if (!existsSync(index)) throw new Error('Production frontend is missing. Run npm run build before starting the server.');
  app.use('/assets',(req,res,next)=>{
    if (!staticAssetPath(`/assets${req.path}`)) {res.status(404).end();return;}
    next();
  },express.static(path.join(dist,'assets'),{dotfiles:'deny',index:false,redirect:false,fallthrough:false,maxAge:'1y',immutable:true}));
  app.get('/{*path}',(req,res)=>{
    if (!PAGES.has(req.path)) {res.status(404).end();return;}
    res.sendFile(index,{headers:{'Cache-Control':'no-store'}});
  });
}
