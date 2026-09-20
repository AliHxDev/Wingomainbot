import express from 'express';
import bcrypt from 'bcryptjs';
import { query, withTransaction } from '../db/index.mjs';
import { env } from '../config/env.mjs';
import { requireAuth, signSession, setSessionCookie, clearSessionCookie } from '../middleware/auth.mjs';
import { validate } from '../middleware/validation.mjs';
import { loginSchema } from '../utils/validation.mjs';
import { authLimiter } from '../middleware/security.mjs';

export const authRouter = express.Router();

async function hasAdmin() {
  const { rows } = await query('SELECT EXISTS(SELECT 1 FROM app_users) AS exists');
  return rows[0].exists;
}

authRouter.get('/status', async (req,res,next) => {
  try {
    const setupRequired = !(await hasAdmin());
    let user = null;
    const token = req.cookies?.[env.COOKIE_NAME];
    if (token) {
      try {
        const jwt = await import('jsonwebtoken');
        const payload = jwt.default.verify(token, env.JWT_SECRET);
        user = { id:String(payload.sub), username:payload.username };
      } catch {}
    }
    res.json({ setupRequired, authenticated:Boolean(user), user });
  } catch(error) { next(error); }
});

authRouter.post('/setup', authLimiter, validate(loginSchema), async (req,res,next) => {
  try {
    const user = await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['wingo-admin-setup']);
      const existing = await client.query('SELECT id FROM app_users LIMIT 1');
      if (existing.rows.length) return null;
      const hash = await bcrypt.hash(req.body.password, 12);
      const created = await client.query('INSERT INTO app_users (username,password_hash) VALUES ($1,$2) RETURNING id,username', [req.body.username,hash]);
      return created.rows[0];
    });
    if (!user) return res.status(409).json({error:'Administrator setup is already complete'});
    const token = signSession(user); setSessionCookie(res, token);
    res.status(201).json({ user:{id:String(user.id),username:user.username} });
  } catch(error) { if (error.code==='23505') return res.status(409).json({error:'Username already exists'}); next(error); }
});

authRouter.post('/login', authLimiter, validate(loginSchema), async (req,res,next) => {
  try {
    const { rows } = await query('SELECT id,username,password_hash FROM app_users WHERE LOWER(username)=LOWER($1) LIMIT 1', [req.body.username]);
    const user = rows[0];
    const valid = user ? await bcrypt.compare(req.body.password,user.password_hash) : false;
    if (!valid) return res.status(401).json({error:'Invalid username or password'});
    const token = signSession(user); setSessionCookie(res,token);
    res.json({user:{id:String(user.id),username:user.username}});
  } catch(error) { next(error); }
});

authRouter.post('/logout', (req,res) => { clearSessionCookie(res); res.json({ok:true}); });

authRouter.get('/me', requireAuth, async (req,res,next) => { try { res.json({user:{id:String(req.user.sub),username:req.user.username}}); } catch(error){next(error);} });
