import axios from "axios";

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  withCredentials: true, // sends cookies on every request automatically
});

// If accessToken cookie expires, this interceptor
// automatically calls /refresh-token and retries the original request
// In frontend/src/lib/api.js
// Change the interceptor to NOT redirect on the current-user check

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // Don't retry the current-user check — it's expected to 401 when logged out
    if (originalRequest.url.includes("/users/current-user")) {
      return Promise.reject(error);
    }

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      try {
        await api.post("/users/refresh-token");
        return api(originalRequest);
      } catch {
        window.location.href = "/login";
        return Promise.reject(error);
      }
    }

    return Promise.reject(error);
  },
);
export default api;
