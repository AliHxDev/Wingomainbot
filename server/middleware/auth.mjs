import jwt from 'jsonwebtoken';
import { env } from '../config/env.mjs';

export function signSession(user) {
  return jwt.sign({ sub:String(user.id), username:user.username }, env.JWT_SECRET, { expiresIn:env.JWT_TTL });
}

export function setSessionCookie(res, token) {
  res.cookie(env.COOKIE_NAME, token, {
    httpOnly:true,
    secure:env.NODE_ENV === 'production',
    sameSite:'lax',
    maxAge:8*60*60*1000,
    path:'/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(env.COOKIE_NAME, { httpOnly:true, secure:env.NODE_ENV==='production', sameSite:'lax', path:'/' });
}

export function requireAuth(req,res,next) {
  const token = req.cookies?.[env.COOKIE_NAME];
  if (!token) return res.status(401).json({ error:'Authentication required' });
  try {
    req.user = jwt.verify(token, env.JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error:'Session expired or invalid' });
  }
}
