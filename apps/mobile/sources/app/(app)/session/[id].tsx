import * as React from 'react';
import { useRoute } from "@react-navigation/native";
import { TerminalScreen } from '@/terminal';


export default React.memo(() => {
    const route = useRoute();
    const sessionId = (route.params! as any).id as string;
    return (<TerminalScreen id={sessionId} />);
});
