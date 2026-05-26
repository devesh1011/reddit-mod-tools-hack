import { createMiddleware } from 'langchain';

export const timingMiddleware = createMiddleware({
  name: 'modradar-timing',
  wrapModelCall: async (request, handler) => {
    const t0 = Date.now();
    try {
      const response = await handler(request);
      console.log(`[modradar:agent] ok ${Date.now() - t0}ms`);
      return response;
    } catch (err) {
      console.error(`[modradar:agent] fail ${Date.now() - t0}ms`, err);
      throw err;
    }
  },
});

