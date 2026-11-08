export type PhotonProfile = {
  profileId: string; name: string; isDefault: boolean; version: number; mediaEncryption: string;
  configuration: {inbound: {destinationUri: string; credentials: {username: string} | null} | null; outbound: unknown};
};
export type PhotonAssignment = {resourceId: string; resourceVersion: number; profileId?: string};

export function sipEnvironmentCredentials(username?: string, password?: string) {
  if (!!username !== !!password) throw new Error('Set both ELEVENLABS_SIP_USERNAME and ELEVENLABS_SIP_PASSWORD, or leave both unset.');
  return username && password ? {username, password} : undefined;
}

export function assertSafeProfile(profile: PhotonProfile, destinationUri: string) {
  if (profile.isDefault || profile.mediaEncryption !== 'auto' || profile.configuration.outbound)
    throw new Error('Existing Honeyline profile has unexpected settings; review it manually.');
  if (profile.configuration.inbound && profile.configuration.inbound.destinationUri !== destinationUri)
    throw new Error('Existing profile routes elsewhere; review it manually.');
}

export function assertUnchangedProfile(previous: PhotonProfile, current: PhotonProfile, destinationUri: string) {
  assertSafeProfile(current, destinationUri);
  if (current.profileId !== previous.profileId || current.version !== previous.version)
    throw new Error('The Honeyline profile changed during inspection; review a fresh dry-run before applying.');
}

export function assertUnchangedAssignment(previous: PhotonAssignment, current: PhotonAssignment, profileId: string) {
  if (current.resourceId !== previous.resourceId || current.profileId !== previous.profileId || (current.profileId && current.profileId !== profileId))
    throw new Error('A selected line assignment changed during inspection; review a fresh dry-run before applying.');
}
