import axios from 'axios';

const api = axios.create({ baseURL: '/api', timeout: 10000 });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('access_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  async (error) => {
    const orig = error.config;
    if (error.response?.status === 401 && !orig._retry) {
      orig._retry = true;
      const rt = localStorage.getItem('refresh_token');
      if (rt) {
        try {
          const { data } = await axios.post('/api/auth/refresh', { refreshToken: rt });
          localStorage.setItem('access_token', data.accessToken);
          orig.headers.Authorization = `Bearer ${data.accessToken}`;
          return api(orig);
        } catch { localStorage.clear(); window.location.href = '/login'; }
      }
    }
    return Promise.reject(error);
  }
);

export default api;
