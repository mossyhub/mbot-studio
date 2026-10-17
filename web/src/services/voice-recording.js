export const MAX_RECORDING_MS = 3000;
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm', 'audio/ogg'];
const API = '/api/robot/recordings';
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);

export function recordingSupport(env = globalThis) {
  if (!env.isSecureContext) return {error:'Microphone recording needs HTTPS or localhost. Open Studio securely to record.'};
  if (!env.navigator?.mediaDevices?.getUserMedia || !env.MediaRecorder?.isTypeSupported) {
    return {error:'This browser does not support microphone recording. Try a current browser.'};
  }
  const mimeType = MIME_TYPES.find(type => env.MediaRecorder.isTypeSupported(type));
  return mimeType ? {mimeType} : {error:'This browser has no supported audio recording format.'};
}

export function validateRecording(asset) {
  if (!asset || !validId(asset.id) || typeof asset.name !== 'string' || asset.name.length > 200
      || !Number.isFinite(asset.durationMs) || asset.durationMs <= 0 || asset.durationMs > MAX_RECORDING_MS
      || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || typeof asset.ready !== 'boolean') {
    throw new Error('The server returned an invalid recording. Refresh the list and try again.');
  }
  return asset;
}
export function recordingBlock(asset) {
  validateRecording(asset);
  if (!asset.ready) throw new Error('This recording is not ready.');
  return {type:'play_recording', recording:asset.id};
}
export function recordingAudioUrl(id) {
  if (!validId(id)) throw new Error('Invalid recording ID.');
  return `${API}/${encodeURIComponent(id)}/audio`;
}
async function request(url, options, fetcher) {
  const response = await fetcher(url, {...options, credentials:'same-origin', cache:'no-store'});
  const data = response.status === 204 ? null : await response.json().catch(()=>null);
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : `Recording request failed (${response.status}). Try again.`);
  return data;
}
export async function listRecordings({signal, fetcher = globalThis.fetch} = {}) {
  const data = await request(API, {signal}, fetcher);
  const assets = Array.isArray(data) ? data : data?.recordings;
  if (!Array.isArray(assets)) throw new Error('The server returned an invalid recording list.');
  return assets.map(validateRecording);
}
export async function uploadRecording(blob, {name = '', signal, fetcher = globalThis.fetch} = {}) {
  if (!blob?.size || !MIME_TYPES.includes(blob.type.toLowerCase())) throw new Error('Unsupported or empty recording format. Record a new clip.');
  const query = name.trim() ? `?name=${encodeURIComponent(name.trim())}` : '';
  return validateRecording(await request(API + query, {method:'POST', signal, headers:{'Content-Type':blob.type}, body:blob}, fetcher));
}
export async function recordingTransferStatus({signal, fetcher = globalThis.fetch} = {}) {
  const value = await request(`${API}/transfer-status`, {signal}, fetcher);
  if (!value || typeof value.active !== 'boolean' || !Number.isSafeInteger(value.generation) || value.generation < 0
      || !['idle','loading','beginning','transferring','verifying','committing','checking','deleting','succeeded','failed','canceled'].includes(value.phase)
      || !Number.isSafeInteger(value.ackedBytes) || value.ackedBytes < 0
      || (value.totalBytes !== null && (!Number.isSafeInteger(value.totalBytes) || value.totalBytes < 1 || value.totalBytes > 24576 || value.ackedBytes > value.totalBytes))
      || (value.totalBytes === null && value.ackedBytes !== 0)
      || (value.active && (typeof value.sessionId !== 'string' || !value.sessionId || typeof value.bootId !== 'string'))
      || (value.assetId != null && !/^[a-f0-9]{64}$/.test(value.assetId))) throw new Error('Recording progress is unavailable. Sync is still awaiting confirmation.');
  return value;
}
export async function deleteRecording(id, {signal, fetcher = globalThis.fetch} = {}) {
  if (!validId(id)) throw new Error('Invalid recording ID.');
  await request(`${API}/${encodeURIComponent(id)}`, {method:'DELETE', signal}, fetcher);
}
export async function syncRecording(id, {signal, fetcher = globalThis.fetch} = {}) {
  if (!validId(id)) throw new Error('Invalid recording ID.');
  return validateRecording(await request(`${API}/${encodeURIComponent(id)}/sync`, {method:'POST', signal}, fetcher));
}

export function canUseRecordings(status) {
  // Older embedded consumers omit broker state; an explicit disconnect must
  // override the independently aged robot heartbeat.
  return status?.robotOnline === true && status.mqttConnected !== false && Array.isArray(status.capabilities)
    && status.capabilities.includes('recorded_audio_v1');
}
