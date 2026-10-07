import type { CompanyType, Level, TargetRole } from '../../common/domain.js';
import { UserModel, type User } from './model.js';

export const usersRepository = {
  findById(id: string): Promise<User | null> {
    return UserModel.findById(id).lean<User>();
  },

  findByEmail(email: string, opts: { withPassword?: boolean } = {}): Promise<User | null> {
    const q = UserModel.findOne({ email: email.toLowerCase() });
    if (opts.withPassword) q.select('+passwordHash');
    return q.lean<User>();
  },

  findByGoogleId(googleId: string): Promise<User | null> {
    return UserModel.findOne({ googleId }).lean<User>();
  },

  async create(data: {
    email: string;
    name?: string;
    authProvider: 'password' | 'google';
    passwordHash?: string;
    googleId?: string;
  }): Promise<User> {
    const doc = await UserModel.create(data);
    return doc.toObject<User>();
  },

  linkGoogle(id: string, googleId: string): Promise<User | null> {
    return UserModel.findByIdAndUpdate(
      id,
      { $set: { googleId } },
      { returnDocument: 'after' },
    ).lean<User>();
  },

  update(
    id: string,
    patch: Partial<{
      name: string;
      targetRole: TargetRole;
      level: Level;
      companyType: CompanyType;
      onboardedAt: Date;
    }>,
  ): Promise<User | null> {
    return UserModel.findByIdAndUpdate(
      id,
      { $set: patch },
      { returnDocument: 'after', runValidators: true },
    ).lean<User>();
  },
};
