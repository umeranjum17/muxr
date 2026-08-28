import { Platform, Switch as RNSwitch, SwitchProps } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Deferred } from '@/components/Deferred';

export const Switch = (props: SwitchProps) => {
    const { theme } = useUnistyles();
    return (
        <Deferred enabled={Platform.OS === 'android'}>
            <RNSwitch
                {...props}
                trackColor={{ false: theme.colors.switch.track.inactive, true: theme.colors.switch.track.active }}
                ios_backgroundColor={theme.colors.switch.track.inactive}
                thumbColor={props.value ? theme.colors.switch.thumb.active : theme.colors.switch.thumb.inactive}
                {...{
                    activeThumbColor: theme.colors.switch.thumb.active,
                }}
            />
        </Deferred>
    );
}