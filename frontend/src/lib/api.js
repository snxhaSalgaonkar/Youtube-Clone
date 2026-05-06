import axios from "axios";

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  withCredentials: true, // sends cookies on every request automatically
});

// If accessToken cookie expires, this interceptor
// automatically calls /refresh-token and retries the original request
api.interceptors.response.use(
  (response) => response,

  async (error) => {
    const originalRequest = error.config;

    // 401 = token expired, _retry flag prevents infinite loop
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      try {
        // Attempt to get a new accessToken using the refreshToken cookie
        await api.post("/users/refresh-token");
        // Retry the original failed request
        return api(originalRequest);
      } catch (refreshError) {
        // Refresh token also expired → force logout
        window.location.href = "/login";
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  },
);

export default api;
