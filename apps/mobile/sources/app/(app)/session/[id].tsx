import * as React from 'react';
import { useRoute } from "@react-navigation/native";
import { TerminalRoute } from '@/terminal/ui';


export default React.memo(() => {
    const route = useRoute();
    const { id, desktop } = route.params as { id: string; desktop?: string };
    return (<TerminalRoute id={id} desktop={desktop === '1'} />);
});
