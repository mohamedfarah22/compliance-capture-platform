import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import StartTransactionPage from './pages/start/StartTransactionPage.jsx'
import CustomerSearchPage from './pages/customers/CustomerSearchPage.jsx'
import CreateCustomerPage from './pages/customers/create/CreateCustomerPage.jsx'
import TransactionDetailsPage from './pages/transaction-details/TransactionDetailsPage.jsx'
import PlaceholderPage from './pages/PlaceholderPage.jsx'

const pendingPages = [
  {
    path: '/party-details',
    title: 'Party Details',
    description: 'This route is reserved for detailed party information.',
  },
  {
    path: '/conducting-person',
    title: 'Conducting Person Details',
    description: 'This route is reserved for conducting person details.',
  },
  {
    path: '/id-verification',
    title: 'ID Verification Details',
    description: 'This route is reserved for ID verification and capture.',
  },
  {
    path: '/recipient-delivery',
    title: 'Recipient / Delivery',
    description: 'This route is reserved for recipient and delivery details.',
  },
  {
    path: '/bullion-details',
    title: 'Bullion Details',
    description: 'This route is reserved for bullion line items.',
  },
  {
    path: '/review',
    title: 'Review / Validate / Submit',
    description: 'This route is reserved for the final review step.',
  },
]

const App = () => {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<StartTransactionPage />} />
        <Route path="/customers" element={<CustomerSearchPage />} />
        <Route path="/customers/create" element={<CreateCustomerPage />} />
        <Route path="/transaction-details" element={<TransactionDetailsPage />} />
        {pendingPages.map((page) => (
          <Route
            key={page.path}
            path={page.path}
            element={<PlaceholderPage title={page.title} description={page.description} />}
          />
        ))}
        <Route path="/start" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
