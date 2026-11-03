import { generatePath } from "react-router-dom";

export const GOLD_ROUTES = {
    search: "/gold",
    newCustomer: "/gold/customers/new",
    customer: "/gold/customers/:customerId",
    updateId: "/gold/customers/:customerId/update-id",
    editCustomer: "/gold/customers/:customerId/edit",
    toComplete: "/gold/to-complete",
    purchases: "/gold/purchases",
    purchase: "/gold/purchases/:purchaseId",
    completePurchase: "/gold/purchases/:purchaseId/complete",
};

// goldPath(GOLD_ROUTES.customer, { customerId }) -> "/gold/customers/<id>"
export const goldPath = (route, params) => generatePath(route, params);
