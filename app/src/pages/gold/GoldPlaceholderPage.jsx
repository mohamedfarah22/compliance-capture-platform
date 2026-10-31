import { Link } from "react-router-dom";
import WizardFrame from "../../components/layout/WizardFrame.jsx";

// Stand-in until the gold screens ship; replaced by the real /gold routes.
const GoldPlaceholderPage = () => {
    return (
        <WizardFrame title="Gold due diligence" subtitle="Gold due diligence is coming soon.">
            <Link to="/">Back to journeys</Link>
        </WizardFrame>
    );
};

export default GoldPlaceholderPage;
