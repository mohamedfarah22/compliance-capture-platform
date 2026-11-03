import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import ProtectedRoute from "./components/ProtectedRoute.jsx";
import { AuthProvider } from "./context/AuthContext.jsx";
import BullionDetailsPage from "./pages/bullion-details/BullionDetailsPage.jsx";
import { GOLD_JOURNEY_ENABLED, ITEM_AND_DELIVERY_CAPTURE_ENABLED } from "./config/featureFlags.js";
import ConductingPersonPage from "./pages/conducting-person/ConductingPersonPage.jsx";
import CustomerSearchPage from "./pages/customers/CustomerSearchPage.jsx";
import CreateCustomerPage from "./pages/customers/create/CreateCustomerPage.jsx";
import GoldCustomerFormPage from "./pages/gold/GoldCustomerFormPage.jsx";
import GoldCustomerPage from "./pages/gold/GoldCustomerPage.jsx";
import GoldLayout from "./pages/gold/GoldLayout.jsx";
import GoldSearchPage from "./pages/gold/GoldSearchPage.jsx";
import { GOLD_ROUTES } from "./pages/gold/shared/index.js";
import IdVerificationPage from "./pages/id-verification/IdVerificationPage.jsx";
import JourneyPickerPage from "./pages/journey/JourneyPickerPage.jsx";
import LoginPage from "./pages/login/LoginPage.jsx";
import MfaGatePage from "./pages/mfa/MfaGatePage.jsx";
import PartyDetailsPage from "./pages/party-details/PartyDetailsPage.jsx";
import PreciousMetalDetailsPage from "./pages/precious-metal-details/PreciousMetalDetailsPage.jsx";
import RecipientDeliveryPage from "./pages/recipient-delivery/RecipientDeliveryPage.jsx";
import ReportsPage from "./pages/reports/ReportsPage.jsx";
import ReviewBatchPage from "./pages/review-batch/ReviewBatchPage.jsx";
import ReviewSubmitPage from "./pages/review-submit/ReviewSubmitPage.jsx";
import StartTransactionPage from "./pages/start/StartTransactionPage.jsx";
import TransactionCompletePage from "./pages/transaction-complete/TransactionCompletePage.jsx";
import TransactionDetailsPage from "./pages/transaction-details/TransactionDetailsPage.jsx";

// While the flag is off, typing /gold must not get round the hidden picker card.
const GoldRoute = () => (GOLD_JOURNEY_ENABLED ? <GoldLayout /> : <Navigate to="/" replace />);

export const AppRoutes = () => {
    return (
        <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/mfa" element={<MfaGatePage />} />
            <Route
                path="/"
                element={
                    <ProtectedRoute>
                        <JourneyPickerPage />
                    </ProtectedRoute>
                }
            />
            <Route
                path="/start"
                element={
                    <ProtectedRoute>
                        <StartTransactionPage />
                    </ProtectedRoute>
                }
            />
            <Route
                path={GOLD_ROUTES.search}
                element={
                    <ProtectedRoute>
                        <GoldRoute />
                    </ProtectedRoute>
                }
            >
                <Route index element={<GoldSearchPage />} />
                <Route path={GOLD_ROUTES.newCustomer} element={<GoldCustomerFormPage mode="create" />} />
                <Route path={GOLD_ROUTES.customer} element={<GoldCustomerPage />} />
                <Route path={GOLD_ROUTES.updateId} element={<GoldCustomerFormPage mode="update" />} />
                <Route path={GOLD_ROUTES.editCustomer} element={<GoldCustomerFormPage mode="edit" />} />
                <Route path="*" element={<Navigate to={GOLD_ROUTES.search} replace />} />
            </Route>
            <Route
                path="/customers"
                element={
                    <ProtectedRoute>
                        <CustomerSearchPage />
                    </ProtectedRoute>
                }
            />
            <Route
                path="/customers/create"
                element={
                    <ProtectedRoute>
                        <CreateCustomerPage />
                    </ProtectedRoute>
                }
            />
            <Route
                path="/transaction-details"
                element={
                    <ProtectedRoute>
                        <TransactionDetailsPage />
                    </ProtectedRoute>
                }
            />
            <Route
                path="/party-details"
                element={
                    <ProtectedRoute>
                        <PartyDetailsPage />
                    </ProtectedRoute>
                }
            />
            <Route
                path="/conducting-person"
                element={
                    <ProtectedRoute>
                        <ConductingPersonPage />
                    </ProtectedRoute>
                }
            />
            <Route
                path="/id-verification"
                element={
                    <ProtectedRoute>
                        <IdVerificationPage />
                    </ProtectedRoute>
                }
            />
            {ITEM_AND_DELIVERY_CAPTURE_ENABLED && (
                <Route
                    path="/recipient-delivery"
                    element={
                        <ProtectedRoute>
                            <RecipientDeliveryPage />
                        </ProtectedRoute>
                    }
                />
            )}
            {ITEM_AND_DELIVERY_CAPTURE_ENABLED && (
                <Route
                    path="/bullion-details"
                    element={
                        <ProtectedRoute>
                            <BullionDetailsPage />
                        </ProtectedRoute>
                    }
                />
            )}
            {ITEM_AND_DELIVERY_CAPTURE_ENABLED && (
                <Route
                    path="/precious-metal-details"
                    element={
                        <ProtectedRoute>
                            <PreciousMetalDetailsPage />
                        </ProtectedRoute>
                    }
                />
            )}
            <Route
                path="/review"
                element={
                    <ProtectedRoute>
                        <ReviewSubmitPage />
                    </ProtectedRoute>
                }
            />
            <Route
                path="/transaction-complete"
                element={
                    <ProtectedRoute>
                        <TransactionCompletePage />
                    </ProtectedRoute>
                }
            />
            <Route
                path="/reports"
                element={
                    <ProtectedRoute requiredRole="admin">
                        <ReportsPage />
                    </ProtectedRoute>
                }
            />
            <Route
                path="/review-batch/:batchId"
                element={
                    <ProtectedRoute requiredRole="admin">
                        <ReviewBatchPage />
                    </ProtectedRoute>
                }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
    );
};

const App = () => {
    return (
        <BrowserRouter>
            <AuthProvider>
                <AppRoutes />
            </AuthProvider>
        </BrowserRouter>
    );
};

export default App;
