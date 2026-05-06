import axios from "axios";

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL, // http://localhost:8000/api/v1
  withCredentials: true, // CRITICAL: sends cookies (for httpOnly JWT)
  timeout: 10000,
});

// Request interceptor — attach token if not using cookies
api.interceptors.request.use((config) => {
  // If you're using localStorage tokens (not recommended, see mistakes below)
  const token = localStorage.getItem("token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Response interceptor — handle expired tokens globally
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      // Token expired — redirect to login
      window.location.href = "/login";
    }
    return Promise.reject(error);
  },
);

export default api;
