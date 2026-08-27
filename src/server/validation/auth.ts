import { z } from 'zod';

export const credentialsSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(8).max(128),
});

export const passwordSchema = z
  .string()
  .min(8, 'weakPassword')
  .max(128)
  .refine((value) => /[a-zA-Z؀-ۿ]/.test(value) && /\d/.test(value), 'weakPassword');

export const registerSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    email: z.email().max(254),
    password: passwordSchema,
    confirmPassword: z.string(),
    locale: z.enum(['ar', 'en']).default('ar'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'passwordMismatch',
    path: ['confirmPassword'],
  });

export type RegisterInput = z.infer<typeof registerSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

export const forgotPasswordSchema = z.object({
  email: z.email().max(254),
  locale: z.enum(['ar', 'en']).default('ar'),
});

export const resetPasswordSchema = z
  .object({
    uid: z.string().min(1).max(64),
    token: z.string().length(64),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'passwordMismatch',
    path: ['confirmPassword'],
  });

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
