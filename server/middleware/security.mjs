import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env.mjs';

export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:["'self'"],
      scriptSrc:["'self'"],
      styleSrc:["'self'", "'unsafe-inline'"],
      connectSrc:["'self'"],
      imgSrc:["'self'", 'data:'],
      objectSrc:["'none'"],
      baseUri:["'self'"],
      frameAncestors:["'none'"],
    },
  },
});

export const corsMiddleware = cors((req, callback) => {
  const origin = req.get('origin');
  if (!origin) return callback(null, { credentials:true, methods:['GET','POST','PUT','OPTIONS'] });
  const sameOrigin = origin === `${req.protocol}://${req.get('host')}`;
  const configuredOrigin = env.APP_ORIGIN && origin === env.APP_ORIGIN;
  const localOrigin = origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173';
  if (sameOrigin || configuredOrigin || localOrigin) {
    return callback(null, { origin:true, credentials:true, methods:['GET','POST','PUT','OPTIONS'] });
  }
  return callback(new Error('CORS origin denied'));
});

export const apiLimiter = rateLimit({ windowMs:15*60*1000, limit:200, standardHeaders:'draft-7', legacyHeaders:false, message:{error:'Too many requests; retry later.'} });
export const authLimiter = rateLimit({ windowMs:15*60*1000, limit:10, standardHeaders:'draft-7', legacyHeaders:false, message:{error:'Too many authentication attempts; retry later.'} });
export const pairingLimiter = rateLimit({ windowMs:15*60*1000, limit:5, standardHeaders:'draft-7', legacyHeaders:false, message:{error:'Too many pairing attempts; retry later.'} });

export function stateChangingOriginGuard(req,res,next) {
  if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  const sameOrigin = origin === `${req.protocol}://${req.get('host')}`;
  const configuredOrigin = env.APP_ORIGIN && env.APP_ORIGIN === origin;
  const localOrigin = origin === `http://localhost:${env.PORT}` || origin === `http://127.0.0.1:${env.PORT}` || origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173';
  if (sameOrigin || configuredOrigin || localOrigin) return next();
  return res.status(403).json({error:'Request origin rejected'});
}
