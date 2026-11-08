import test from 'node:test';
import assert from 'node:assert/strict';
import { assertUnchangedAssignment, assertUnchangedProfile, sipEnvironmentCredentials, type PhotonProfile } from '../scripts/photon-validation';

const destination = 'sips:sip.rtc.elevenlabs.io:5061';
const profile: PhotonProfile = {profileId:'profile',name:'Honeyline demo inbound',isDefault:false,version:3,mediaEncryption:'auto',configuration:{inbound:{destinationUri:destination,credentials:null},outbound:null}};

test('incomplete environment credentials fail instead of selecting saved credentials', () => {
  assert.throws(() => sipEnvironmentCredentials('user',undefined), /Set both/);
  assert.throws(() => sipEnvironmentCredentials('', 'password'), /Set both/);
  assert.equal(sipEnvironmentCredentials(undefined,undefined),undefined);
  assert.deepEqual(sipEnvironmentCredentials('user','password'),{username:'user',password:'password'});
});

test('a fresh profile read rejects concurrent route and configuration changes', () => {
  assert.doesNotThrow(() => assertUnchangedProfile(profile,structuredClone(profile),destination));
  assert.throws(() => assertUnchangedProfile(profile,{...profile,version:4},destination), /changed during inspection/);
  assert.throws(() => assertUnchangedProfile(profile,{...profile,configuration:{...profile.configuration,inbound:{destinationUri:'sips:other.example',credentials:null}}},destination), /routes elsewhere/);
  assert.throws(() => assertUnchangedProfile(profile,{...profile,mediaEncryption:'disabled'},destination), /unexpected settings/);
  assert.throws(() => assertUnchangedProfile(profile,{...profile,configuration:{...profile.configuration,outbound:{enabled:true}}},destination), /unexpected settings/);
});

test('a fresh line read cannot overwrite a changed assignment', () => {
  const previous = {resourceId:'line',resourceVersion:2};
  assert.doesNotThrow(() => assertUnchangedAssignment(previous,{...previous,resourceVersion:3},profile.profileId));
  assert.throws(() => assertUnchangedAssignment(previous,{...previous,profileId:'another-profile'},profile.profileId), /changed during inspection/);
  assert.throws(() => assertUnchangedAssignment({...previous,profileId:profile.profileId},previous,profile.profileId), /changed during inspection/);
  assert.throws(() => assertUnchangedAssignment(previous,{...previous,resourceId:'another-line'},profile.profileId), /changed during inspection/);
});
