import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],root:'web',publicDir:'public',build:{outDir:'../dist/web',emptyOutDir:true},server:{host:'127.0.0.1',port:5173,proxy:{'/api/':{target:'http://127.0.0.1:3000',ws:true},'/readyz':'http://127.0.0.1:3000','/healthz':'http://127.0.0.1:3000'}}});
