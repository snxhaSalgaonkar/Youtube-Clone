// utils/buildLikeQuery.js

const buildLikeQuery = (userId, targetId, targetType) => {
  return {
    likedBy: userId,
    targetId,
    targetType,
  };
};

export { buildLikeQuery };
