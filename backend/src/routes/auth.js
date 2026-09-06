import { Router } from 'express';
import { createUser, findByEmail, verifyPassword } from '../models/userModel.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { validateEmail, validatePassword, ValidationError } from '../utils/validation.js';

const router = Router();

router.post(
  '/register',
  asyncRoute(async (req, res) => {
    const email = validateEmail(req.body?.email);
    const password = validatePassword(req.body?.password);

    if (findByEmail(email)) {
      throw Object.assign(new Error('An account with that email already exists'), { status: 409 });
    }

    const user = createUser(email, password);
    res.status(201).json({ token: signToken(user), user: { id: user.id, email: user.email } });
  })
);

router.post(
  '/login',
  asyncRoute(async (req, res) => {
    const email = validateEmail(req.body?.email);
    const password = req.body?.password;
    const user = findByEmail(email);

    // One message for both "no such user" and "wrong password", so the endpoint
    // cannot be used to enumerate which emails have accounts.
    if (!user || typeof password !== 'string' || !verifyPassword(user, password)) {
      throw Object.assign(new ValidationError('Incorrect email or password'), { status: 401 });
    }

    res.json({ token: signToken(user), user: { id: user.id, email: user.email } });
  })
);

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email, lastSeenAt: req.user.last_seen_at } });
});

export default router;
