import type { Persona, SetupStatus } from './contracts';

/** Discovery can run before any phone line is provisioned or tested. */
export function modelDemoReady(setup: SetupStatus): boolean {
  return setup.database.connected && setup.model.configured;
}

export function isPhoneNumber(phone: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(phone);
}

/** A submission receipt or imported number alone must never enable a call link. */
export function phonePresentation(persona: Pick<Persona,'phone'|'voiceReady'|'voiceAgentId'>): {state:'tested'|'untested'|'browser-only';label:string;href:string|null} {
  if (!isPhoneNumber(persona.phone)) return {state:'browser-only',label:'BROWSER ONLY',href:null};
  if (!persona.voiceReady || !persona.voiceAgentId) return {state:'untested',label:'TEST NEEDED',href:null};
  return {state:'tested',label:'CALL ME',href:`tel:${persona.phone}`};
}

export function modelDemoStartMessage(setup: SetupStatus): string {
  return `Live demo started with model analysis. Phone lines tested: ${setup.voice.configured} of ${setup.voice.total}.`;
}
