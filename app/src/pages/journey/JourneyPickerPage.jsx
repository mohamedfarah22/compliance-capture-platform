import { Link } from "react-router-dom";
import WizardFrame from "../../components/layout/WizardFrame.jsx";
import { GOLD_JOURNEY_ENABLED } from "../../config/featureFlags.js";
import { useAuth } from "../../context/AuthContext.jsx";
import styles from "./JourneyPickerPage.module.css";

const JourneyPickerPage = () => {
    const { canApproveReports } = useAuth();

    const journeys = [
        {
            to: "/start",
            title: "Threshold transaction report (TTR)",
            description: "Record a reportable bullion or precious metal transaction for AUSTRAC.",
        },
        ...(GOLD_JOURNEY_ENABLED
            ? [
                  {
                      to: "/gold",
                      title: "Gold due diligence",
                      description: "Record scrap and bullion purchases and keep the customer checks on file.",
                  },
              ]
            : []),
        ...(canApproveReports
            ? [
                  {
                      to: "/reports",
                      title: "Reports",
                      description: "Review and approve the daily AUSTRAC report batches.",
                  },
              ]
            : []),
    ];

    return (
        <WizardFrame title="What would you like to do?" subtitle="Choose a journey to start.">
            <ul className={styles.list}>
                {journeys.map((journey) => (
                    <li key={journey.to}>
                        <Link className={styles.card} to={journey.to}>
                            <span className={styles.title}>{journey.title}</span>
                            <span className={styles.description}>{journey.description}</span>
                        </Link>
                    </li>
                ))}
            </ul>
        </WizardFrame>
    );
};

export default JourneyPickerPage;
