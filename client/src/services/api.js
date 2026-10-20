import axios from 'axios';

// All requests go to /api on the same origin; Vite proxies them to Express.
export const api = axios.create({ baseURL: '/api', timeout: 15000 });

let token = null;
let onUnauthorized = null;

export function setAuthToken(t) {
  token = t;
}
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

api.interceptors.request.use((config) => {
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response && err.response.status === 401 && token && onUnauthorized) onUnauthorized();
    return Promise.reject(err);
  }
);

/** Turn any request failure into a sentence a person can act on. */
export function errorMessage(err) {
  if (!err) return 'Something went wrong.';
  const body = err.response && err.response.data;
  if (body && body.error) {
    const { message, details } = body.error;
    if (Array.isArray(details) && details.length) {
      const first = details[0];
      return `${message}: ${first.path ? `${first.path} ` : ''}${first.message}`;
    }
    return message;
  }
  if (err.code === 'ECONNABORTED') return 'The server took too long to answer. Check your connection and try again.';
  if (err.request && !err.response) return 'Cannot reach the server. Check your connection and try again.';
  return err.message || 'Something went wrong.';
}

const unwrap = (p) => p.then((r) => r.data.data);

export const authApi = {
  register: (body) => unwrap(api.post('/auth/register', body)),
  login: (body) => unwrap(api.post('/auth/login', body)),
  me: () => unwrap(api.get('/auth/me')),
  providers: () => unwrap(api.get('/auth/providers')),
  requestOtp: (phone) => unwrap(api.post('/auth/otp/request', { phone })),
  verifyOtp: (phone, code) => unwrap(api.post('/auth/otp/verify', { phone, code })),
  google: (idToken) => unwrap(api.post('/auth/google', { idToken })),
  linkGoogle: (idToken) => unwrap(api.post('/auth/google/link', { idToken })),
};

export const vehiclesApi = {
  list: () => unwrap(api.get('/vehicles')),
};

export const rideApi = {
  estimate: (body) => unwrap(api.post('/rides/estimate', body)),
  create: (body) => unwrap(api.post('/rides', body)),
  get: (id) => unwrap(api.get(`/rides/${id}`)),
  events: (id) => unwrap(api.get(`/rides/${id}/events`)),
  history: (page = 1) => unwrap(api.get('/rides/history', { params: { page, limit: 20 } })),
  cancel: (id, reason) => unwrap(api.post(`/rides/${id}/cancel`, reason ? { reason } : {})),
  pay: (id) => unwrap(api.post(`/rides/${id}/pay`, {})),
  arrive: (id) => unwrap(api.post(`/rides/${id}/arrive`, {})),
  start: (id, otp) => unwrap(api.post(`/rides/${id}/start`, { otp })),
  complete: (id, otp) => unwrap(api.post(`/rides/${id}/complete`, { otp })),
  otp: (id) => unwrap(api.get(`/rides/${id}/otp`)),
  messages: (id, params) => unwrap(api.get(`/rides/${id}/messages`, { params })),
  sendMessage: (id, body) => unwrap(api.post(`/rides/${id}/messages`, body)),
  reportMessage: (id, messageId, reason) => unwrap(api.post(`/rides/${id}/messages/${messageId}/report`, { reason })),
  review: (id, body) => unwrap(api.post(`/rides/${id}/reviews`, body)),
  myReview: (id) => unwrap(api.get(`/rides/${id}/reviews/mine`)),
  reportSafety: (id, body) => unwrap(api.post(`/rides/${id}/safety-incidents`, body)),
  cashCollected: (id) => unwrap(api.post(`/rides/${id}/cash-collected`, {})),
};

export const driverApi = {
  me: () => unwrap(api.get('/drivers/me')),
  setAvailability: (availability) => unwrap(api.patch('/drivers/me/availability', { availability })),
  updateLocation: (pos) => unwrap(api.patch('/drivers/me/location', pos)),
  offers: () => unwrap(api.get('/drivers/me/offers')),
  activeRide: () => unwrap(api.get('/drivers/me/active-ride')),
  trips: (page = 1) => unwrap(api.get('/drivers/me/trips', { params: { page, limit: 20 } })),
  accept: (offerId) => unwrap(api.post(`/offers/${offerId}/accept`, {})),
  reject: (offerId) => unwrap(api.post(`/offers/${offerId}/reject`, {})),
  onboarding: () => unwrap(api.get('/drivers/me/onboarding')),
  documents: () => unwrap(api.get('/drivers/me/documents')),
  uploadDocument: (type, file) => {
    const form = new FormData();
    form.append('type', type);
    form.append('file', file);
    return unwrap(api.post('/drivers/me/documents', form, { timeout: 60000 }));
  },
  updateIdentity: (identity) => unwrap(api.put('/drivers/me/identity', { identity })),
  submitForReview: () => unwrap(api.post('/drivers/me/submit-for-review', {})),
  femaleProgram: (action) => unwrap(api.post('/drivers/me/female-program', action === 'REQUEST' ? { action, consent: true } : { action })),
};

export const reviewsApi = {
  received: (page = 1) => unwrap(api.get('/reviews/received', { params: { page, limit: 20 } })),
  given: (page = 1) => unwrap(api.get('/reviews/given', { params: { page, limit: 20 } })),
};

export const safetyApi = {
  config: () => unwrap(api.get('/safety/config')),
  get: (id) => unwrap(api.get(`/safety/incidents/${id}`)),
};

export const adminApi = {
  metrics: () => unwrap(api.get('/admin/metrics')),
  users: (params) => unwrap(api.get('/admin/users', { params })),
  user: (id) => unwrap(api.get(`/admin/users/${id}`)),
  setAccountStatus: (id, accountStatus, reason) => unwrap(api.patch(`/admin/users/${id}/status`, reason ? { accountStatus, reason } : { accountStatus })),
  drivers: (params) => unwrap(api.get('/admin/drivers', { params })),
  driver: (id) => unwrap(api.get(`/admin/drivers/${id}`)),
  decide: (driverId, body) => unwrap(api.patch(`/admin/drivers/${driverId}/approval`, body)),
  femaleVerification: (driverId, status, note) => unwrap(api.patch(`/admin/drivers/${driverId}/female-verification`, note ? { status, note } : { status })),
  setCapacity: (driverId, capacity, reason) => unwrap(api.patch(`/admin/drivers/${driverId}/vehicle`, reason ? { capacity, reason } : { capacity })),
  // Returns a Blob (never a public URL) for an authorised, audited document view.
  documentFile: (driverId, documentId) => api.get(`/admin/drivers/${driverId}/documents/${documentId}/file`, { responseType: 'blob' }).then((r) => r.data),
  rides: (params) => unwrap(api.get('/admin/rides', { params })),
  ride: (id) => unwrap(api.get(`/admin/rides/${id}`)),
  cancelRide: (id, reason) => unwrap(api.post(`/admin/rides/${id}/cancel`, { reason })),
  reviews: (params) => unwrap(api.get('/admin/reviews', { params })),
  moderateReview: (id, status, reason) => unwrap(api.patch(`/admin/reviews/${id}/moderation`, reason ? { status, reason } : { status })),
  incidents: (params) => unwrap(api.get('/admin/safety-incidents', { params })),
  incident: (id) => unwrap(api.get(`/admin/safety-incidents/${id}`)),
  incidentAction: (id, action, note) => unwrap(api.patch(`/admin/safety-incidents/${id}`, note ? { action, note } : { action })),
  chatReports: (params) => unwrap(api.get('/admin/chat-reports', { params })),
  conversation: (rideId) => unwrap(api.get(`/admin/rides/${rideId}/messages`)),
  resolveChatReport: (id) => unwrap(api.patch(`/admin/chat-reports/${id}`, {})),
  payments: (params) => unwrap(api.get('/admin/payments', { params })),
  requestRefund: (id, reason) => unwrap(api.post(`/admin/payments/${id}/refund-request`, { reason })),
  auditLogs: (params) => unwrap(api.get('/admin/audit-logs', { params })),
};
