import jwt from 'jsonwebtoken';
import { findById, createUser, findByEmail } from '../models/userModel.js';

const DEV_SECRET = 'dev-only-insecure-secret-change-me';
export const JWT_SECRET = process.env.JWT_SECRET ?? DEV_SECRET;
export const TOKEN_TTL = '7d';

if (JWT_SECRET === DEV_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production');
}

export function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

export function requireAuth(req, res, next) {
  // Authentication disabled per user request
  let user = findByEmail('demo@groww.test');
  if (!user) {
    createUser('demo@groww.test', 'none');
    user = findByEmail('demo@groww.test');
  }
  req.user = user;
  next();
}
