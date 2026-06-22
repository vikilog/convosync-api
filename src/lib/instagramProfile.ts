export type InstagramUserProfile = {
  name?: string;
  username?: string;
  profile_pic?: string;
  follower_count?: number;
  follows_count?: number;
  media_count?: number;
  is_verified_user?: boolean;
  is_user_follow_business?: boolean;
  is_business_follow_user?: boolean;
  biography?: string;
};

export const INSTAGRAM_USER_PROFILE_FIELDS = [
  'name',
  'username',
  'profile_pic',
  'follower_count',
  'is_verified_user',
  'is_user_follow_business',
  'is_business_follow_user',
].join(',');

const PROFILE_STALE_MS = 24 * 60 * 60 * 1000;

export function shouldRefreshInstagramProfile(
  customFields: Record<string, string> | null | undefined
): boolean {
  const updatedAt = customFields?.instagramProfileUpdatedAt;
  if (!updatedAt) return true;
  const age = Date.now() - Date.parse(updatedAt);
  return Number.isNaN(age) || age > PROFILE_STALE_MS;
}

export function instagramProfileToCustomFields(
  profile: InstagramUserProfile,
  existing?: Record<string, string> | null
): Record<string, string> {
  const out: Record<string, string> = { ...(existing || {}) };

  if (profile.username) out.instagramUsername = profile.username;
  if (profile.biography) out.instagramBio = profile.biography;
  if (profile.follower_count != null) {
    out.instagramFollowerCount = String(profile.follower_count);
  }
  if (profile.follows_count != null) {
    out.instagramFollowsCount = String(profile.follows_count);
  }
  if (profile.media_count != null) {
    out.instagramMediaCount = String(profile.media_count);
  }
  if (profile.is_verified_user != null) {
    out.instagramVerified = profile.is_verified_user ? 'yes' : 'no';
  }
  if (profile.is_user_follow_business != null) {
    out.instagramFollowsBusiness = profile.is_user_follow_business ? 'yes' : 'no';
  }
  if (profile.is_business_follow_user != null) {
    out.instagramBusinessFollowsUser = profile.is_business_follow_user ? 'yes' : 'no';
  }

  out.instagramProfileUpdatedAt = new Date().toISOString();
  return out;
}

export function resolveInstagramContactName(
  profile: InstagramUserProfile,
  senderId: string,
  fallbackName?: string
): string {
  if (profile.name?.trim()) return profile.name.trim();
  if (fallbackName?.trim()) return fallbackName.trim();
  if (profile.username) return `@${profile.username}`;
  return `Instagram ${senderId.slice(-6)}`;
}

export function formatInstagramFollowerCount(value: string | undefined): string | null {
  if (!value) return null;
  const n = Number(value);
  if (Number.isNaN(n)) return value;
  return n.toLocaleString('en-IN');
}
