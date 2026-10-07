import { Errors } from '../../common/errors.js';
import type { User } from './model.js';
import { usersRepository } from './repository.js';
import type { UpdateMeInput } from './schemas.js';

export function toPublicUser(user: User) {
  return {
    id: user._id.toString(),
    email: user.email,
    name: user.name ?? null,
    role: user.role,
    authProvider: user.authProvider,
    targetRole: user.targetRole ?? null,
    level: user.level ?? null,
    companyType: user.companyType ?? null,
    onboarded: Boolean(user.onboardedAt),
    createdAt: user.createdAt,
  };
}

export type PublicUser = ReturnType<typeof toPublicUser>;

export const usersService = {
  async getMe(userId: string): Promise<PublicUser> {
    const user = await usersRepository.findById(userId);
    if (!user) throw Errors.notFound('User');
    return toPublicUser(user);
  },

  async updateMe(userId: string, input: UpdateMeInput): Promise<PublicUser> {
    const current = await usersRepository.findById(userId);
    if (!current) throw Errors.notFound('User');

    const merged = { ...current, ...input };
    const completesOnboarding =
      !current.onboardedAt && merged.targetRole && merged.level && merged.companyType;

    const updated = await usersRepository.update(userId, {
      ...input,
      ...(completesOnboarding ? { onboardedAt: new Date() } : {}),
    });
    if (!updated) throw Errors.notFound('User');
    return toPublicUser(updated);
  },
};
