export const serializers = {
  req(request: any) {
    return {
      id: request.id,
      method: request.method,
      url: request.url,
      ip: request.ip,
    };
  },

  res(reply: any) {
    return {
      statusCode: reply.statusCode,
    };
  },

  err(error: Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  },
};
