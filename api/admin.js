'use strict';

const { handleAdminApi } = require('../server');

const ADMIN_ROUTE_PATTERN = /^(?:account|bots|manifest|deploy|setups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function getAdminRoute(request) {
  const queryRoute = request.query && request.query.route;
  if (typeof queryRoute === 'string') return queryRoute;
  if (Array.isArray(queryRoute)) return null;
  try {
    return new URL(request.url, 'https://tesla-host.invalid').searchParams.get('route');
  } catch {
    return null;
  }
}

module.exports = async function adminFunction(request, response) {
  const route = getAdminRoute(request);
  const pathname = typeof route === 'string' && ADMIN_ROUTE_PATTERN.test(route)
    ? `/api/admin/${route}`
    : '/api/admin/invalid';
  await handleAdminApi(request, response, pathname);
};
