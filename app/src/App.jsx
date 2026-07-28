import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import ProtectedRoute from './components/ProtectedRoute.jsx'
import { AuthProvider } from './context/AuthContext.jsx'
import BullionDetailsPage from './pages/bullion-details/BullionDetailsPage.jsx'
import ConductingPersonPage from './pages/conducting-person/ConductingPersonPage.jsx'
import CustomerSearchPage from './pages/customers/CustomerSearchPage.jsx'
import CreateCustomerPage from './pages/customers/create/CreateCustomerPage.jsx'
import IdVerificationPage from './pages/id-verification/IdVerificationPage.jsx'
import LoginPage from './pages/login/LoginPage.jsx'
import MfaGatePage from './pages/mfa/MfaGatePage.jsx'
import PartyDetailsPage from './pages/party-details/PartyDetailsPage.jsx'
import PreciousMetalDetailsPage from './pages/precious-metal-details/PreciousMetalDetailsPage.jsx'
import RecipientDeliveryPage from './pages/recipient-delivery/RecipientDeliveryPage.jsx'
import ReportsPage from './pages/reports/ReportsPage.jsx'
import ReviewBatchPage from './pages/review-batch/ReviewBatchPage.jsx'
import ReviewSubmitPage from './pages/review-submit/ReviewSubmitPage.jsx'
import StartTransactionPage from './pages/start/StartTransactionPage.jsx'
import TransactionCompletePage from './pages/transaction-complete/TransactionCompletePage.jsx'
import TransactionDetailsPage from './pages/transaction-details/TransactionDetailsPage.jsx'

const App = () => {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/mfa" element={<MfaGatePage />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <StartTransactionPage />
              </ProtectedRoute>
            }
          />
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
          <Route
            path="/recipient-delivery"
            element={
              <ProtectedRoute>
                <RecipientDeliveryPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/bullion-details"
            element={
              <ProtectedRoute>
                <BullionDetailsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/precious-metal-details"
            element={
              <ProtectedRoute>
                <PreciousMetalDetailsPage />
              </ProtectedRoute>
            }
          />
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
          <Route path="/start" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}

export default App
