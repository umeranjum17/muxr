import * as React from 'react';
import { useRoute } from "@react-navigation/native";
import { BrowserWatchWorkspace } from '@/takeover/presentation/BrowserWatchWorkspace';


export default React.memo(() => {
    const route = useRoute();
    const sessionId = (route.params! as any).id as string;
    return (<BrowserWatchWorkspace id={sessionId} />);
});
