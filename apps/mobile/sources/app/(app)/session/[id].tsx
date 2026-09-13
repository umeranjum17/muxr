import * as React from 'react';
import { useRoute } from "@react-navigation/native";
import { AgentSurfaceWorkspace } from '@/preview/presentation/AgentSurfaceWorkspace';


export default React.memo(() => {
    const route = useRoute();
    const sessionId = (route.params! as any).id as string;
    return (<AgentSurfaceWorkspace id={sessionId} />);
});
