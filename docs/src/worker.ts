type Env = {
  ASSETS: { fetch(request: Request): Promise<Response> };
};

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const url = new URL(request.url);
    if (url.hostname === 'shirei.dev') {
      url.protocol = 'https:';
      url.hostname = 'durability.shirei.dev';
      url.port = '';
      return Response.redirect(url.href, 308);
    }
    return env.ASSETS.fetch(request);
  },
};
