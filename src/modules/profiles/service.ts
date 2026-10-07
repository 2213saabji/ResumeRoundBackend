import { Errors } from '../../common/errors.js';
import type { CandidateProfile } from './model.js';
import { profilesRepository } from './repository.js';
import type { UpdateProfileInput } from './schemas.js';

export function toPublicProfile(p: CandidateProfile) {
  return {
    id: p._id.toString(),
    resumeId: p.resumeId?.toString() ?? null,
    experienceYears: p.experienceYears,
    seniority: p.seniority,
    domain: p.domain ?? null,
    skills: p.skills,
    projects: p.projects,
    editedByUser: p.editedByUser,
    updatedAt: p.updatedAt,
  };
}

export const profilesService = {
  async getCurrent(userId: string) {
    const profile = await profilesRepository.findActive(userId);
    if (!profile) throw Errors.notFound('Profile');
    return toPublicProfile(profile);
  },

  async updateCurrent(userId: string, input: UpdateProfileInput) {
    const profile = await profilesRepository.updateActive(userId, input);
    if (!profile) throw Errors.notFound('Profile');
    return toPublicProfile(profile);
  },
};
