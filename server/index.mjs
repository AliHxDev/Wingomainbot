import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pinoHttp from 'pino-http';
import { env } from './config/env.mjs';
import { logger } from './utils/logger.mjs';
import { migrate } from './db/migrate.mjs';
import { pool } from './db/index.mjs';
import { securityHeaders, corsMiddleware, apiLimiter, stateChangingOriginGuard } from './middleware/security.mjs';
import { authRouter } from './routes/auth.mjs';
import { createApiRouter } from './routes/api.mjs';
import { WhatsAppManager } from './services/whatsapp.mjs';
import { BotEngine } from './services/botEngine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname,'../public');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy',1);
app.use(pinoHttp({logger}));
app.use(securityHeaders);
app.use(corsMiddleware);
app.use(cookieParser());
app.use(express.json({limit:'64kb'}));
app.use(express.urlencoded({extended:false,limit:'32kb'}));
app.use(stateChangingOriginGuard);
app.use('/api', apiLimiter);

app.get('/api/health', async (req,res) => {
  try { await pool.query('SELECT 1'); res.json({ok:true,service:'wingo-whatsapp-bot',timestamp:new Date().toISOString()}); }
  catch { res.status(503).json({ok:false,service:'wingo-whatsapp-bot'}); }
});
app.use('/api/auth', authRouter);

const whatsapp = new WhatsAppManager();
const bot = new BotEngine(whatsapp);
app.use('/api', createApiRouter({whatsapp,bot}));

app.use(express.static(publicDir,{index:false,maxAge:env.NODE_ENV==='production'?'1h':0}));
app.get('*',(req,res,next)=>{
  if (req.path.startsWith('/api/')) return res.status(404).json({error:'API route not found'});
  res.sendFile(path.join(publicDir,'index.html'), error => error && next(error));
});

app.use((error,req,res,next)=>{
  const requestId = req.id || undefined;
  req.log?.error({err:error,requestId}, 'Unhandled request error');
  if (res.headersSent) return next(error);
  const status = error.statusCode || (error.message?.includes('CORS') ? 403 : 500);
  res.status(status).json({error: status >= 500 ? 'Internal server error' : error.message});
});

let server;
async function main() {
  await migrate();
  await whatsapp.init();
  await bot.init();
  server = app.listen(env.PORT,()=>logger.info({port:env.PORT},'WinGo Signal Console listening'));
}

async function shutdown(signal) {
  logger.info({signal},'Shutdown requested');
  try { await bot.stop(); } catch(error){ logger.error({err:error},'Bot shutdown failed'); }
  try { await whatsapp.shutdown(); } catch(error){ logger.error({err:error},'WhatsApp shutdown failed'); }
  if (server) await new Promise(resolve=>server.close(resolve));
  await pool.end();
  process.exit(0);
}
process.on('SIGINT',()=>shutdown('SIGINT'));
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('uncaughtException',error=>logger.fatal({err:error},'Uncaught exception'));
process.on('unhandledRejection',error=>logger.error({err:error},'Unhandled rejection'));

if (process.env.NODE_ENV !== 'test') main().catch(error=>{ logger.fatal({err:error},'Application startup failed'); process.exit(1); });

export { app };
