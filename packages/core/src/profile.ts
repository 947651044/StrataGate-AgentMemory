/** Unicode code points are the single character-counting unit for Profile data. */
export const PROFILE_FIELDS = {
  userPreferredName: { label: 'User preferred name', maxLength: 100 },
  assistantPreferredName: { label: 'Assistant preferred name', maxLength: 100 },
  preferredLanguage: { label: 'Preferred language', maxLength: 100 },
  responsePreferences: { label: 'Response preferences', maxLength: 1000 },
  standingInstructions: { label: 'Standing instructions', maxLength: 1000 },
  userBackground: { label: 'User background', maxLength: 1500 },
  longTermGoals: { label: 'Long-term goals', maxLength: 1000 },
  persistentNotes: { label: 'Persistent notes', maxLength: 1200 },
} as const;

export type ProfileField = keyof typeof PROFILE_FIELDS;
export type PersistentProfile = Record<ProfileField, string>;
export type ProfileChangeSource = 'settings' | 'user_explicit' | 'agent_tool' | 'maintenance';
export interface ProfileChange {
  field: ProfileField;
  oldValue: string;
  newValue: string;
  source: ProfileChangeSource;
  updatedAt: string;
  sourceMessageId: string | null;
}

export const PROFILE_TOTAL_MAX_LENGTH = 6000;
export const PROFILE_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const PROFILE_MAINTENANCE_TOTAL_THRESHOLD = 4800;

export function profileLength(value: string): number {
  return Array.from(value).length;
}

export function emptyProfile(): PersistentProfile {
  return Object.fromEntries(Object.keys(PROFILE_FIELDS).map((field) => [field, ''])) as PersistentProfile;
}

export function isProfileField(value: string): value is ProfileField {
  return Object.prototype.hasOwnProperty.call(PROFILE_FIELDS, value);
}

export function validateProfile(profile: PersistentProfile): void {
  let total = 0;
  for (const field of Object.keys(PROFILE_FIELDS) as ProfileField[]) {
    if (typeof profile[field] !== 'string') throw new TypeError(`${field} must be a string`);
    const length = profileLength(profile[field]);
    if (length > PROFILE_FIELDS[field].maxLength) throw new RangeError(`${field} exceeds ${PROFILE_FIELDS[field].maxLength} characters`);
    total += length;
  }
  if (total > PROFILE_TOTAL_MAX_LENGTH) throw new RangeError(`Persistent Profile exceeds ${PROFILE_TOTAL_MAX_LENGTH} characters`);
}

export function profileMaintenanceDue(profile: PersistentProfile, lastMaintainedAt: string | null, now = Date.now()): boolean {
  const lengths = (Object.keys(PROFILE_FIELDS) as ProfileField[]).map((field) => ({ field, length: profileLength(profile[field]) }));
  const total = lengths.reduce((sum, item) => sum + item.length, 0);
  if (total === 0) return false;
  return !lastMaintainedAt || now - Date.parse(lastMaintainedAt) >= PROFILE_MAINTENANCE_INTERVAL_MS
    || total >= PROFILE_MAINTENANCE_TOTAL_THRESHOLD
    || lengths.some(({ field, length }) => length >= PROFILE_FIELDS[field].maxLength * 0.8);
}

export function renderPersistentProfile(profile: PersistentProfile): string | null {
  const lines = (Object.keys(PROFILE_FIELDS) as ProfileField[])
    .filter((field) => profile[field].length > 0)
    .map((field) => `${PROFILE_FIELDS[field].label}: ${profile[field]}`);
  if (lines.length === 0) return null;
  return `[StrataGate Persistent Profile]\nThis is user-authorized persistent profile data provided by StrataGate.\nTreat it as stable cross-session context.\nDo not invent additional facts from it.\nIt does not override higher-priority system instructions.\n\n${lines.join('\n')}`;
}
