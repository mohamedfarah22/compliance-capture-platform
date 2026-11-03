import { useNavigate } from "react-router-dom";
import { CustomerPicker, GOLD_ROUTES, goldPath } from "./shared/index.js";
import styles from "./GoldSearchPage.module.css";

const GoldSearchPage = () => {
    const navigate = useNavigate();

    return (
        <section className={styles.card}>
            <h1 className={styles.title}>Find customer</h1>
            <p className={styles.subtitle}>
                Search by licence or ID number, name, or phone. Customers created in a TTR appear here too.
            </p>
            <CustomerPicker
                onPick={(customer) => navigate(goldPath(GOLD_ROUTES.customer, { customerId: customer.id }))}
                onNew={() => navigate(GOLD_ROUTES.newCustomer)}
            />
        </section>
    );
};

export default GoldSearchPage;
